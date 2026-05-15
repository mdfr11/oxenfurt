# Oxenfurt

Telegram Mini App for structured English practice. Vocabulary + theory
cards from live-lesson transcripts, FSRS-scheduled review.

See [`BRIEF.md`](./BRIEF.md) for the full project brief.

## Layout

```
apps/
  mini-app/       # Vite + React 19 + TypeScript (TWA frontend)
  backend/        # Bun + Hono + Drizzle + Postgres (practice service)
packages/
  shared/         # Valibot schemas + FSRS wrapper, shared front/back
```

## Toolchain

- **Bun** 1.3+ — runtime for backend, test runner
- **pnpm** 10+ — workspace manager
- **Node** 22+ — for Vite (frontend tooling)
- **Postgres** 17 — for backend (production); not required for shared package tests

## Setup

```sh
pnpm install
pnpm test            # run all package tests
pnpm typecheck       # typecheck all packages
```

### Local Postgres

```sh
docker compose up -d postgres
docker compose ps              # wait for "(healthy)"
```

The compose file binds Postgres to `127.0.0.1:5432` only. Default
credentials are `oxenfurt / oxenfurt / oxenfurt` (user / password /
database) — fine for local dev, replace for any shared environment.

### Backend dev server

```sh
cp apps/backend/.env.example apps/backend/.env
# fill BOT_TOKEN, JWT_SECRET (≥32 chars), INGEST_TOKEN
cd apps/backend && bun --watch src/index.ts
```

## Status

In progress: bootstrap. See `BRIEF.md` § 11 "Предлагаемые первые шаги".
