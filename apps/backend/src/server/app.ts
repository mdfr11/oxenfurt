import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { FsrsService } from '@oxenfurt/shared'
import { validateInitData } from '../auth/initData.ts'
import { signSession } from '../auth/jwt.ts'
import type { Db } from '../db/client.ts'
import { createIngestRouter } from '../ingest/cards.ts'
import { createCardsRouter } from '../cards/router.ts'

export interface AppDeps {
  botToken: string
  jwtSecret: string
  ingestToken: string
  ownerTelegramUserId: number
  initDataMaxAgeSeconds: number
  jwtTtlSeconds: number
  db: Db
  fsrs?: FsrsService
  /** Allow-list of origins for the dev CORS middleware. When empty / unset,
   *  no CORS middleware is installed — production stack is same-origin
   *  through the reverse proxy. */
  corsAllowedOrigins?: string[]
  /** Gate for the dev-only `/auth/dev-token` endpoint. Default off. */
  enableDevAuth?: boolean
  /** TTL for dev-tokens, seconds. Defaults to 3600 (1 h). */
  devAuthTtlSeconds?: number
  /** Override for tests. Defaults to `() => new Date()`. */
  now?: () => Date
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())
  const fsrs = deps.fsrs ?? new FsrsService()

  // CORS only when explicit allow-list is provided (dev / staging).
  // In production the reverse proxy serves both Mini App and API from the
  // same origin, so the browser never sends a preflight.
  if (deps.corsAllowedOrigins && deps.corsAllowedOrigins.length > 0) {
    const allowed = new Set(deps.corsAllowedOrigins)
    const allowAny = allowed.has('*')
    app.use(
      '*',
      cors({
        origin: (origin) => {
          if (allowAny) return origin ?? '*'
          if (origin && allowed.has(origin)) return origin
          return null
        },
        credentials: !allowAny,
        allowHeaders: ['authorization', 'content-type'],
      }),
    )
  }

  app.get('/health', (c) => c.json({ ok: true }))

  // Dev-only endpoint: issues a JWT without Telegram auth. Off by default.
  // Production blocks ENABLE_DEV_AUTH=true at config-load (config.ts).
  if (deps.enableDevAuth) {
    app.get('/auth/dev-token', async (c) => {
      const ttl = deps.devAuthTtlSeconds ?? 3600
      const token = await signSession(
        { userId: deps.ownerTelegramUserId },
        deps.jwtSecret,
        { ttlSeconds: ttl, now: now() },
      )
      return c.json({ token, expires_in: ttl })
    })
  }

  app.post('/auth/session', async (c) => {
    let initDataRaw: string | undefined
    const contentType = c.req.header('content-type') ?? ''
    if (contentType.includes('application/json')) {
      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'invalid_body' }, 400)
      }
      if (body !== null && typeof body === 'object' && 'initData' in body) {
        const v = (body as Record<string, unknown>).initData
        if (typeof v === 'string') initDataRaw = v
      }
    } else {
      const auth = c.req.header('authorization') ?? ''
      const match = auth.match(/^tma\s+(.+)$/i)
      if (match) initDataRaw = match[1]
    }

    if (initDataRaw === undefined) {
      return c.json({ error: 'missing_init_data' }, 400)
    }

    const result = validateInitData(initDataRaw, {
      botToken: deps.botToken,
      maxAgeSeconds: deps.initDataMaxAgeSeconds,
      now: now(),
    })
    if (!result.ok) {
      return c.json({ error: result.reason }, 401)
    }

    // Single-user gate: only the configured owner gets a session.
    if (result.user.id !== deps.ownerTelegramUserId) {
      return c.json({ error: 'forbidden' }, 403)
    }

    const token = await signSession({ userId: result.user.id }, deps.jwtSecret, {
      ttlSeconds: deps.jwtTtlSeconds,
      now: now(),
    })

    return c.json({
      token,
      expires_in: deps.jwtTtlSeconds,
      user: {
        id: result.user.id,
        first_name: result.user.first_name ?? null,
        username: result.user.username ?? null,
        language_code: result.user.language_code ?? null,
      },
    })
  })

  app.route(
    '/ingest',
    createIngestRouter({
      db: deps.db,
      ingestToken: deps.ingestToken,
      fsrs,
      now,
    }),
  )

  app.route(
    '/cards',
    createCardsRouter({
      db: deps.db,
      jwtSecret: deps.jwtSecret,
      fsrs,
      now,
    }),
  )

  return app
}
