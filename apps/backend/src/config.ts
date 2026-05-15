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
  }
  const config = v.parse(ConfigSchema, raw)

  // Loud refusal if dev-auth is on in production — never silently allow it.
  if (config.NODE_ENV === 'production' && config.ENABLE_DEV_AUTH) {
    throw new Error('ENABLE_DEV_AUTH must not be true in NODE_ENV=production')
  }
  return config
}
