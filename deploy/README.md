# Oxenfurt — VPS Deployment

Single-VPS, single-user, native systemd. Postgres + Bun backend + Caddy
fronting the static mini-app. Co-locates with an existing
**hermes-english.service**; integration described in
[`hermes/integration.md`](hermes/integration.md).

> **Handing off to an agent?** Use [`AGENT_GUIDE.md`](AGENT_GUIDE.md)
> instead. It's the same content as this file, restructured as a
> sequence of stages an autonomous agent on the VPS can execute
> top-to-bottom, with verifications after each stage and error-recovery
> branches. This README is the operator-facing reference; the agent
> guide is the executable plan.

If you ever need the Docker-Compose path (multi-host or k8s migration),
see [`legacy/`](legacy/README.md).

---

## Architecture on the VPS

```
                     internet
                        │
                  ┌─────▼─────┐
                  │   Caddy   │  443/TCP, auto-TLS via Let's Encrypt
                  └──┬─────┬──┘
                     │     │
        /api/* (proxy)     /  /assets/*  (static)
                     │     │
            ┌────────▼─┐ ┌─▼──────────────────┐
            │ oxenfurt │ │ /opt/oxenfurt/     │
            │ -backend │ │   mini-app/        │
            │ :3000    │ │     (Vite dist)    │
            └────┬─────┘ └────────────────────┘
                 │
                 │  loopback HTTP
                 │
            ┌────▼──────────┐
            │  postgres     │  127.0.0.1:5432
            └───────────────┘
                 ▲
                 │ POST /ingest/cards (loopback, Bearer auth)
                 │
            ┌────┴──────────┐
            │ hermes-       │  systemd, already running
            │ english       │
            └───────────────┘
```

All non-Caddy services bind to `127.0.0.1` only; ufw blocks every port
except 22 / 80 / 443.

---

## Prerequisites

- **VPS on Ubuntu** (22.04 or 24.04 — both fine). ≥ 2 GB RAM; the 8 GB you
  have is comfortable.
- **A domain** pointed at the VPS via DNS A record (and AAAA if IPv6).
  Telegram Mini App requires HTTPS — there is no way around the
  certificate dance; Telegram WebView fetches the app over the public
  internet from your device. Caddy obtains the cert automatically.
  - **For personal use, the free path is DuckDNS** (`*.duckdns.org`).
    Register at <https://www.duckdns.org> via OAuth (no email
    verification), create a subdomain, point it at the VPS IP. Caddy
    handles TLS via HTTP-01; BotFather accepts `*.duckdns.org` for Mini
    Apps. Migration to a paid domain later is a Caddyfile edit + one
    `@BotFather /setdomain` round-trip.
  - **For ownership long-term**, a cheap registrar (Porkbun, Namecheap,
    Cloudflare Registrar) costs ~$10/year. Recommended once the app
    becomes habit-forming.
  - Self-signed certs, raw IPs, and Cloudflare Tunnel's ephemeral
    `*.trycloudflare.com` URLs are all dead-ends for Telegram Mini
    Apps — don't try.
- **A Telegram bot.** You already have one — that's `BOT_TOKEN`.
- **SSH access** as a user with `sudo` (or root).

---

## First-time setup

### 1. Bootstrap the VPS

From your laptop, copy this `deploy/` directory to the VPS and run the
setup script as root.

```sh
rsync -avz deploy/ root@your-vps:/tmp/oxenfurt-deploy/
ssh root@your-vps bash /tmp/oxenfurt-deploy/vps-setup.sh
```

This is idempotent — re-running is safe.

What it does:

- `apt install` postgresql, ufw, rsync, gnupg, ca-certificates
- Installs Caddy from the official cloudsmith repo
- Installs Bun system-wide → `/usr/local/bin/bun`
- Installs pnpm static binary → `/usr/local/bin/pnpm`
- Creates the `oxenfurt` system user, group, and `/opt/oxenfurt` layout
- Creates the `oxenfurt` Postgres role + database, stashes the generated
  password in `/etc/oxenfurt/.pg_password` (mode 0640, root:oxenfurt)
- Enables ufw with 22 / 80 / 443

Output ends with the manual next steps; follow them.

### 2. Configure secrets

```sh
ssh root@your-vps
cd /tmp/oxenfurt-deploy

cp env/backend.env.example /etc/oxenfurt/backend.env
editor /etc/oxenfurt/backend.env
```

Fill in:

- `BOT_TOKEN` — from @BotFather, the existing bot
- `OWNER_TELEGRAM_USER_ID` — your Telegram user ID (send `/start` to
  @userinfobot)
- `JWT_SECRET` — `openssl rand -base64 32` on the VPS
- `INGEST_TOKEN` — `openssl rand -hex 32` on the VPS
- `DATABASE_URL` — paste the password from `/etc/oxenfurt/.pg_password`
- `SCOPES` / `INGEST_TOKENS` — optional, multi-scope installs only; see
  `deploy/env/backend.env.example` and `deploy/hermes/integration.md`
  → "Adding a scope"

Permissions:

```sh
chown root:oxenfurt /etc/oxenfurt/backend.env
chmod 0640 /etc/oxenfurt/backend.env
```

### 3. Configure Caddy

```sh
editor /tmp/oxenfurt-deploy/Caddyfile     # replace oxenfurt.example.com
                                          # with your real domain twice
cp /tmp/oxenfurt-deploy/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

The first request after a fresh deploy will pause for a few seconds
while Caddy obtains a Let's Encrypt cert. Watch with:

```sh
journalctl -u caddy -f
```

### 4. Install systemd units

```sh
cp /tmp/oxenfurt-deploy/systemd/oxenfurt-backend.service /etc/systemd/system/
cp /tmp/oxenfurt-deploy/systemd/oxenfurt-backup.service  /etc/systemd/system/
cp /tmp/oxenfurt-deploy/systemd/oxenfurt-backup.timer    /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now oxenfurt-backup.timer
# oxenfurt-backend.service is started by deploy.sh after the first rsync.
```

### 5. First deploy from your laptop

Back on your laptop:

```sh
export OXENFURT_VPS=root@your-vps
export OXENFURT_DOMAIN=oxenfurt.example.com
export OXENFURT_SSH_PORT=22

./deploy/deploy.sh
```

The script:

1. Builds `apps/mini-app` locally with `VITE_API_URL=""` (same-origin).
2. `rsync` backend + shared package + workspace metadata to
   `/opt/oxenfurt/releases/<timestamp>/`.
3. `rsync` the built mini-app dist to `/opt/oxenfurt/mini-app/`.
4. Runs `pnpm install --frozen-lockfile --filter=@oxenfurt/backend... --prod`
   on the VPS to populate `node_modules`.
5. Runs `bun src/db/migrate.ts` to apply Drizzle migrations.
6. Atomically swaps `/opt/oxenfurt/current` → the new release dir.
7. `systemctl restart oxenfurt-backend`.
8. Curls `https://your-domain/api/health` and aborts the script if it
   doesn't get 200.

### 6. Tell Telegram where the Mini App lives

In a chat with @BotFather:

```
/setdomain
  → choose your bot
  → enter oxenfurt.example.com

/newapp                  # if your bot has no Mini App yet
  → choose your bot
  → title:        Oxenfurt
  → description:  Карточки английского из живых уроков
  → photo:        upload a square icon
  → web app URL:  https://oxenfurt.example.com
  → short name:   oxenfurt

# (or /editapp to update an existing one)
```

After this, the existing `/study` command (or whatever your bot uses)
can open the Mini App via an inline `web_app` button pointing at the
short-name link.

### 7. Wire Hermes Agent

[Hermes Agent](https://hermes-agent.nousresearch.com/docs/) is what's
running as `hermes-english.service` on your VPS. The integration adds one
skill file and one env-file leaf — full walkthrough in
[`hermes/integration.md`](hermes/integration.md). Roughly:

```sh
# On VPS:

# 7a. Shared env leaf with the ingest token
cp env/hermes-shared.env.example /etc/oxenfurt/hermes-shared.env
editor /etc/oxenfurt/hermes-shared.env   # paste the same INGEST_TOKEN

# 7b. Drop-in override to load it into hermes-english.service
systemctl edit hermes-english.service
# Add:
#   [Service]
#   EnvironmentFile=/etc/oxenfurt/hermes-shared.env

# 7c. Install the skill into the english profile (idiomatic CLI):
sudo -u <hermes-user> hermes -p english skills install \
  /tmp/oxenfurt-deploy/hermes/skills/oxenfurt_ingest.md

# 7d. Reload + restart
systemctl daemon-reload
systemctl restart hermes-english
```

Replace `<hermes-user>` with whatever owns `hermes-english.service`
(`systemctl show hermes-english -p User`). The skill lands in that user's
`~/.hermes/skills/`. Hermes loads it the next time the gateway starts and
the agent can call it after analysing a transcript.

---

## Day-to-day operations

### Deploy a new version

```sh
./deploy/deploy.sh                  # full
./deploy/deploy.sh --skip-build     # backend-only change
./deploy/deploy.sh --skip-migrate   # no schema changes
```

### Rollback to the previous release

```sh
./deploy/deploy.sh --rollback
```

This switches `/opt/oxenfurt/current` to the second-most-recent release
in `/opt/oxenfurt/releases/` and restarts the backend.

### Logs

```sh
ssh root@your-vps
journalctl -u oxenfurt-backend -f
journalctl -u caddy -f
journalctl -u oxenfurt-backup -n 50
```

### Backups

A daily backup runs at 03:00 server time via
`oxenfurt-backup.timer` → `oxenfurt-backup.service` →
`/opt/oxenfurt/current/deploy/backup.sh`.

Backups go to `/opt/oxenfurt/backups/oxenfurt-YYYYMMDD-HHMMSS.sql.gz`,
rotated after `BACKUP_RETENTION_DAYS` (default 14). To enable off-site
copies, install rclone and set `BACKUP_RCLONE_REMOTE=r2:oxenfurt-backups`
(or your S3 alias) in `backend.env`.

Manual backup:

```sh
sudo systemctl start oxenfurt-backup
journalctl -u oxenfurt-backup -n 30
```

Restore:

```sh
gunzip -c /opt/oxenfurt/backups/oxenfurt-20260515-030014.sql.gz \
  | psql -U oxenfurt -d oxenfurt
```

### Token rotation

The default scope's agent token (`INGEST_TOKEN`):

```sh
NEW=$(openssl rand -hex 32)
sed -i "s/^INGEST_TOKEN=.*/INGEST_TOKEN=${NEW}/" /etc/oxenfurt/backend.env
sed -i "s/^OXENFURT_INGEST_TOKEN=.*/OXENFURT_INGEST_TOKEN=${NEW}/" /etc/oxenfurt/hermes-shared.env
systemctl restart oxenfurt-backend hermes-english
```

On a multi-scope install each additional scope has its own token inside
`INGEST_TOKENS=slug=token,...` (in `backend.env`) mirrored into that
agent's env leaf (`/etc/oxenfurt/hermes-<slug>.env`). Rotate them the
same way — replace the value after `slug=`, in both files, then restart
the backend and that scope's Hermes service:

```sh
NEW=$(openssl rand -hex 32)
SLUG=go
sed -i "s/\(${SLUG}=\)[0-9a-f]*/\1${NEW}/" /etc/oxenfurt/backend.env
sed -i "s/^OXENFURT_INGEST_TOKEN=.*/OXENFURT_INGEST_TOKEN=${NEW}/" /etc/oxenfurt/hermes-${SLUG}.env
systemctl restart oxenfurt-backend hermes-${SLUG}
```

Rotating one scope's token never disturbs the others — a token IS its
scope, and the others simply don't match it anymore.

JWT_SECRET rotation invalidates existing sessions — users have to re-open
the Mini App. Same procedure: edit `backend.env`, restart backend.

---

## Resource budget on an 8 GB VPS

Approximate steady-state RSS:

| Process            | RAM  |
|--------------------|------|
| Postgres           | 200 MB (defaults) |
| oxenfurt-backend   | 80-120 MB (Bun)  |
| Caddy              | 20 MB |
| hermes-english     | depends on your model, often hundreds of MB |
| journald + sshd    | ~50 MB |

Oxenfurt's overhead is small. The `MemoryMax=512M` in the backend unit is
a guardrail, not a target.

---

## Troubleshooting

**Backend fails to start with `ENABLE_DEV_AUTH must not be true in NODE_ENV=production`.**
Edit `/etc/oxenfurt/backend.env` and set `ENABLE_DEV_AUTH=false`. The check
is intentional: it prevents shipping a backdoor by accident.

**`pnpm install` fails on VPS with `ERR_PNPM_NO_LOCKFILE`.**
The lockfile wasn't rsynced. Confirm `pnpm-lock.yaml` exists in the release
dir; if not, re-run `./deploy.sh` (the rsync rules include it).

**Caddy can't get a cert (`obtain: solving challenges: presenting for challenge`).**
DNS hasn't propagated yet, or your VPS isn't reachable on port 80 from the
public internet. Check `dig +short A oxenfurt.example.com` matches the VPS,
and that ufw allows 80.

**Mini App in Telegram shows a stale build.**
TWA caches aggressively. Check `Cache-Control` for `index.html` is
`no-cache, no-store` (Caddy header in the Caddyfile). On Telegram desktop,
right-click → Inspect → DevTools → Application → Clear storage to force-refresh.

**`/api/cards/due` returns 401 even after `/api/auth/session` succeeded.**
Check the system clock on the VPS — a >15-minute drift breaks JWT
validation. Run `timedatectl status`; if not synced, `systemctl enable
--now systemd-timesyncd`.

**Hermes ingest hits 401 / 403.**
See [`hermes/integration.md`](hermes/integration.md) → Troubleshooting.

---

## File index

```
deploy/
├── README.md                          ← this file
├── vps-setup.sh                       ← one-time VPS bootstrap (root)
├── deploy.sh                          ← per-release deploy (laptop)
├── backup.sh                          ← invoked by oxenfurt-backup.service
├── Caddyfile                          ← reverse proxy config
├── env/
│   ├── backend.env.example            ← /etc/oxenfurt/backend.env template
│   └── hermes-shared.env.example      ← /etc/oxenfurt/hermes-shared.env
├── systemd/
│   ├── oxenfurt-backend.service
│   ├── oxenfurt-backup.service
│   └── oxenfurt-backup.timer
├── hermes/
│   ├── integration.md                 ← how to wire hermes-english
│   └── skills/oxenfurt_ingest.md      ← skill file for Hermes
└── legacy/                            ← Docker-Compose path (not active)
```
