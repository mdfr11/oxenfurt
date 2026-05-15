import { loadConfig } from './config.ts'
import { createDb } from './db/client.ts'
import { createApp } from './server/app.ts'

const config = loadConfig()
const { db } = createDb(config.DATABASE_URL)

// Dev-only CORS allow-list. Production runs same-origin through nginx/Caddy
// and installs no CORS middleware.
const corsAllowedOrigins =
  config.NODE_ENV === 'production'
    ? []
    : [
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://localhost:3001',
        'http://127.0.0.1:3001',
      ]

const app = createApp({
  botToken: config.BOT_TOKEN,
  jwtSecret: config.JWT_SECRET,
  ingestToken: config.INGEST_TOKEN,
  ownerTelegramUserId: config.OWNER_TELEGRAM_USER_ID,
  initDataMaxAgeSeconds: config.INITDATA_MAX_AGE_SECONDS,
  jwtTtlSeconds: config.JWT_TTL_SECONDS,
  db,
  corsAllowedOrigins,
  enableDevAuth: config.ENABLE_DEV_AUTH,
})

Bun.serve({
  port: config.PORT,
  hostname: '127.0.0.1',
  fetch: app.fetch,
})

console.log(`oxenfurt-backend listening on 127.0.0.1:${config.PORT}`)
