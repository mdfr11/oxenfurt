import * as v from 'valibot'

const StringToInt = (min: number, max: number = Number.MAX_SAFE_INTEGER) =>
  v.pipe(
    v.string(),
    v.transform((s) => Number.parseInt(s, 10)),
    v.integer(),
    v.minValue(min),
    v.maxValue(max),
  )

const BooleanFlag = v.pipe(
  v.optional(v.string(), 'false'),
  v.transform((s) => s === 'true' || s === '1'),
)

const ConfigSchema = v.object({
  BOT_TOKEN: v.pipe(v.string(), v.minLength(1)),
  JWT_SECRET: v.pipe(v.string(), v.minLength(32)),
  INGEST_TOKEN: v.pipe(v.string(), v.minLength(16)),
  DATABASE_URL: v.pipe(v.string(), v.minLength(1)),
  // Single-user gate: only this Telegram user ID may obtain a session.
  OWNER_TELEGRAM_USER_ID: StringToInt(1),
  PORT: StringToInt(1, 65535),
  INITDATA_MAX_AGE_SECONDS: StringToInt(60),
  JWT_TTL_SECONDS: StringToInt(60),
  NODE_ENV: v.optional(v.picklist(['development', 'production', 'test'] as const), 'development'),
  ENABLE_DEV_AUTH: BooleanFlag,
  // Scope list: `slug:Title:emoji:accent,slug:…`. First entry is the
  // default scope (the one INGEST_TOKEN belongs to and the one
  // scope-less requests fall back to). Format is validated by
  // parseScopesConfig at boot — see db/scopes.ts.
  SCOPES: v.optional(v.string()),
  // Per-scope agent tokens: `slug=token,slug=token`. Slugs must exist in
  // SCOPES. The default scope's token stays in INGEST_TOKEN for backward
  // compatibility with existing deployments.
  INGEST_TOKENS: v.optional(v.string()),
  // Optional LLM provider — uses any OpenAI-compatible /chat/completions
  // endpoint. Leave all three unset to disable AI features (semantic
  // grading, future Hermes-side enrichment) without breaking the app.
  // Examples:
  //   Anthropic:   LLM_API_BASE_URL=https://api.anthropic.com/v1, LLM_MODEL=claude-haiku-4-5
  //   Moonshot:    https://api.moonshot.cn/v1,  moonshot-v1-8k
  //   Together AI: https://api.together.xyz/v1, meta-llama/Llama-3.3-70B
  //   OpenRouter:  https://openrouter.ai/api/v1, anthropic/claude-4.5
  LLM_API_BASE_URL: v.optional(v.string()),
  LLM_API_KEY: v.optional(v.string()),
  LLM_MODEL: v.optional(v.string()),
})

export type Config = v.InferOutput<typeof ConfigSchema>

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const raw = {
    BOT_TOKEN: env.BOT_TOKEN,
    JWT_SECRET: env.JWT_SECRET,
    INGEST_TOKEN: env.INGEST_TOKEN,
    DATABASE_URL: env.DATABASE_URL,
    OWNER_TELEGRAM_USER_ID: env.OWNER_TELEGRAM_USER_ID,
    PORT: env.PORT ?? '3000',
    INITDATA_MAX_AGE_SECONDS: env.INITDATA_MAX_AGE_SECONDS ?? '3600',
    JWT_TTL_SECONDS: env.JWT_TTL_SECONDS ?? '900',
    NODE_ENV: env.NODE_ENV,
    ENABLE_DEV_AUTH: env.ENABLE_DEV_AUTH,
    SCOPES: env.SCOPES,
    INGEST_TOKENS: env.INGEST_TOKENS,
    LLM_API_BASE_URL: env.LLM_API_BASE_URL,
    LLM_API_KEY: env.LLM_API_KEY,
    LLM_MODEL: env.LLM_MODEL,
  }
  const config = v.parse(ConfigSchema, raw)

  // Loud refusal if dev-auth is on in production — never silently allow it.
  if (config.NODE_ENV === 'production' && config.ENABLE_DEV_AUTH) {
    throw new Error('ENABLE_DEV_AUTH must not be true in NODE_ENV=production')
  }
  return config
}