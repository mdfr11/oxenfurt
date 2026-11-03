import { loadConfig } from './config.ts'
import { createDb } from './db/client.ts'
import { createApp } from './server/app.ts'
import {
  DEFAULT_SCOPES_CONFIG,
  parseIngestTokensConfig,
  parseScopesConfig,
  syncScopes,
} from './db/scopes.ts'

const config = loadConfig()

const scopeEntries = parseScopesConfig(config.SCOPES ?? DEFAULT_SCOPES_CONFIG)

// Agent tokens: INGEST_TOKEN owns the DEFAULT scope (first configured);
// INGEST_TOKENS adds one token per additional scope. A token IS the scope —
// an agent can never act outside the deck its token belongs to.
const tokenScopes = new Map<string, { slug: string; id: string }>()
tokenScopes.set(config.INGEST_TOKEN, { slug: scopeEntries[0]!.slug, id: '' })
const extraTokens = parseIngestTokensConfig(config.INGEST_TOKENS ?? '')
const slugs = new Set(scopeEntries.map((entry) => entry.slug))
for (const { slug, token } of extraTokens) {
  if (!slugs.has(slug)) {
    throw new Error(`INGEST_TOKENS references unknown scope "${slug}" — not declared in SCOPES`)
  }
  if (tokenScopes.has(token)) {
    throw new Error(`duplicate ingest token for scope "${slug}"`)
  }
  tokenScopes.set(token, { slug, id: '' })
}

const { db } = createDb(config.DATABASE_URL)

// Migrations are applied by deploy.sh (`bun src/db/migrate.ts`), not at
// boot — the scope sync below only upserts rows and therefore requires
// 0007_scopes to have landed first.
const scopeRows = await syncScopes(db, scopeEntries)
// The scope ids only exist after the sync; backfill the token map now that
// slug → id is known.
const slugToRef = new Map(scopeRows.map((row) => [row.slug, { slug: row.slug, id: row.id }]))
for (const [token, ref] of tokenScopes) {
  const resolved = slugToRef.get(ref.slug)
  if (resolved === undefined) {
    throw new Error(`scope "${ref.slug}" disappeared during sync — this is a bug`)
  }
  tokenScopes.set(token, resolved)
}

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
  scopes: scopeRows,
  tokenScopes,
  ownerTelegramUserId: config.OWNER_TELEGRAM_USER_ID,
  initDataMaxAgeSeconds: config.INITDATA_MAX_AGE_SECONDS,
  jwtTtlSeconds: config.JWT_TTL_SECONDS,
  db,
  corsAllowedOrigins,
  enableDevAuth: config.ENABLE_DEV_AUTH,
  llmConfig: {
    baseUrl: config.LLM_API_BASE_URL,
    apiKey: config.LLM_API_KEY,
    model: config.LLM_MODEL,
  },
})

Bun.serve({
  port: config.PORT,
  hostname: '127.0.0.1',
  fetch: app.fetch,
})

console.log(
  `oxenfurt-backend listening on 127.0.0.1:${config.PORT} ` +
    `(scopes: ${scopeRows.map((row) => row.slug).join(', ')})`,
)
