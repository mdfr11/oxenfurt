# Oxenfurt

Telegram Mini App for structured English practice on top of live-lesson
transcripts. Cards (vocabulary + theory) are extracted by a Hermes Agent
from chat transcripts, scheduled with FSRS-5, and reviewed inside a
mobile-first Mini App opened from the Telegram bot.

Single-user, self-hosted on a VPS alongside the existing Hermes service.

## Features

**Card review**
- FSRS-5 spaced repetition, 4-button rating (Снова / Трудно / Хорошо / Лёгко) with real interval previews
- 5 practice modes: **Узнавание** (recognition), **Письмо** (cloze with fuzzy match), **Перевод** (RU→EN typed), **Слух** (TTS listening), **Смешанно** (random non-audio mix)
- Per-card variant is stable in mixed mode (hash of `card.id` — never re-rolls mid-session)
- "Не знаю — показать ответ" link to skip a typed answer without penalty
- "Тренировать вне расписания" mode when the FSRS queue is empty but you still want to drill
- Undo window after a rating
- Tap-anywhere reveal on recognition; tap again to flip back
- UI sound effects (Web Audio) + server-side TTS (Google Translate proxy, falls back to system SpeechSynthesis)

**Card management**
- **Library** screen: filter by type / status, full-text search across `term` / `translation` / `question`, bottom-sheet card detail with archive action
- Archive is a soft delete — card hides from `/cards/due` and from the active Library filter but stays in the DB

**Stats**
- Today / 7d / 30d review counts + accuracy
- Forecast: due now / due-in-24h / total active
- GitHub-style activity heatmap (last ~6 months horizontally scrollable)
- Last 10 finished sessions with date, time, count, accuracy

**Settings** (per-device)
- Practice mode default, TTS speed (slow / normal / fast), sound on/off, haptics on/off

**Telegram integration**
- HMAC validation of `initData` on `/auth/session` → 15-min JWT (refresh via re-open)
- Single-user gate: only `OWNER_TELEGRAM_USER_ID` can obtain a session
- MainButton, BackButton (with confirm popup), haptic feedback, `sendData` summary back to chat
- `disableVerticalSwipes` during a session so a rating gesture can't close the Mini App
- TWA cache busting (Caddy `no-cache` on `index.html`, content-hash on `/assets/*`)

**Hermes integration**
- `POST /ingest/cards` (Bearer `INGEST_TOKEN`) — discriminated payload `{ type: 'vocab' | 'theory', payload, source?, source_quote? }`
- Vocab cards deduplicated by case-insensitive `term`
- All cards enter `status='active'` immediately (no approval gate; archive bad ones from the Library)
- Skill file ships in `deploy/hermes/skills/oxenfurt_ingest.md`

## Architecture

```
                          internet
                              │
                       ┌──────▼──────┐
                       │    Caddy    │  443/TCP, auto-TLS Let's Encrypt
                       └──┬───────┬──┘
                          │       │
         /api/* (proxy)   │       │   /, /assets/* (static)
                          │       │
              ┌───────────▼─┐  ┌──▼──────────────────┐
              │  oxenfurt-  │  │ /opt/oxenfurt/      │
              │  backend    │  │   mini-app/         │
              │  127.0.0.1: │  │   (Vite static dist)│
              │  3000       │  └─────────────────────┘
              └─────┬───────┘
                    │ loopback
                    │
              ┌─────▼─────────────┐
              │  Postgres 17      │  127.0.0.1:5432
              └─────▲─────────────┘
                    │
                    │ POST /ingest/cards (loopback + Bearer)
                    │
              ┌─────┴───────────┐
              │ hermes-english  │  existing systemd unit
              │ (Hermes Agent)  │
              └─────────────────┘
```

All non-Caddy services bind to `127.0.0.1`. Same-origin between Mini App
and backend via Caddy reverse proxy.

## Stack

- **Backend** — Bun 1.3 + Hono + Drizzle ORM + `postgres.js` + Valibot
- **Mini App** — Vite + React 19 + Telegram SDK + TanStack Query + Tailwind + Framer Motion
- **Shared** — Valibot schemas + `ts-fsrs` 5.x + fuzzy-match helper
- **Workspace** — pnpm 10+
- **Tests** — `bun test` (60+ unit + DB-integration tests)
- **CI** — GitHub Actions: typecheck + tests against real Postgres 17 service container + lint + build

## Project layout

```
apps/
  backend/        Bun + Hono + Drizzle + Postgres practice service
  mini-app/       Vite + React 19 + Telegram SDK Mini App frontend
packages/
  shared/         Valibot schemas, FSRS wrapper, fuzzy-match
deploy/
  README.md         Operator-facing deployment guide
  AGENT_GUIDE.md    Stage-by-stage plan for an autonomous agent on the VPS
  vps-setup.sh      One-shot Ubuntu bootstrap
  deploy.sh         rsync + restart per release
  systemd/          Unit files for backend + nightly pg_dump
  Caddyfile         Reverse-proxy + static host
  hermes/           Skill file + integration walkthrough
  env/              .env templates
design/
  prototype.html    Original UI design prototype
```

## Local development

Requires **Bun 1.3+**, **pnpm 10+**, **Node 22+**, **Docker** (for the
Postgres container only).

```sh
pnpm install
docker compose up -d postgres   # local Postgres on 127.0.0.1:5432

cp apps/backend/.env.example apps/backend/.env
# fill BOT_TOKEN, JWT_SECRET (≥32 chars), INGEST_TOKEN, OWNER_TELEGRAM_USER_ID

# Backend (auto-reloads on save)
cd apps/backend && bun --watch src/index.ts

# Mini-app (in another shell)
cd apps/mini-app && pnpm dev

# All tests + typecheck
pnpm typecheck && pnpm test
```

The Mini App opens at <http://localhost:5173>. It fetches `/auth/dev-token`
from the backend in dev mode and skips Telegram HMAC validation — set
`ENABLE_DEV_AUTH=true` in `apps/backend/.env`.

## Production deployment

### One-shot installer (recommended for first-time deploy)

On a fresh Ubuntu/Debian VPS, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/mdfr11/oxenfurt/master/deploy/install.sh | bash
```

The script asks four questions (bot token, your Telegram user id,
domain, email) and an optional fifth block for AI provider credentials,
then:

- installs Bun, pnpm, Postgres, Caddy, ufw
- generates `JWT_SECRET` and `INGEST_TOKEN`
- creates the Postgres role + database
- writes `/etc/oxenfurt/backend.env` with all values
- templates the Caddyfile with your domain, reloads Caddy
- installs systemd units + nightly backup timer
- clones the repo, builds frontend + backend, runs migrations
- starts the service and prints a healthcheck

For non-interactive runs (CI), set the `OXENFURT_*` env vars listed at
the top of [`deploy/install.sh`](deploy/install.sh) plus
`OXENFURT_NON_INTERACTIVE=1`.

### Manual / step-by-step deployment

If you'd rather understand each step (or you're handing the work to an
autonomous agent on the VPS), see [`deploy/AGENT_GUIDE.md`](deploy/AGENT_GUIDE.md).
The operator-facing guide is [`deploy/README.md`](deploy/README.md).

### Ongoing updates

After the initial install, dev-side updates (build on laptop, rsync to
VPS) use [`deploy/deploy.sh`](deploy/deploy.sh). The install script is
idempotent — re-running it after a `git pull` on the VPS also works,
just slower.

### Hermes integration

Optional — Oxenfurt works fine without it; you just have to feed cards
in via `POST /ingest/cards` yourself. See
[`deploy/hermes/integration.md`](deploy/hermes/integration.md).
