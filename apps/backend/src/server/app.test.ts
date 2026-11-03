import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { createApp, type AppDeps } from './app.ts'
import { verifySession } from '../auth/jwt.ts'
import type { Db } from '../db/client.ts'

const BOT_TOKEN = '1234567890:ABCDEF_test_bot_token'
const JWT_SECRET = '0123456789abcdef0123456789abcdef-test'
const INGEST_TOKEN = 'test-ingest-token-1234567890'
// Static scope fixture — the /health and /auth/session paths under test
// never touch the DB, so the rows are shape-only.
const SCOPE_ROW = {
  id: '00000000-0000-4000-8000-000000000001',
  slug: 'english',
  title: 'English',
  emoji: '🇬🇧',
  accent: 'indigo',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
}
const OWNER_ID = 99
const NOW_MS = Date.parse('2026-01-01T12:00:00.000Z')
const NOW = new Date(NOW_MS)

// These tests cover /health and /auth/session, which do not touch the
// database. A typed stub is sufficient — calling it would throw at runtime,
// which is fine because the tested paths never reach it.
const stubDb = {} as Db

const defaultDeps: AppDeps = {
  botToken: BOT_TOKEN,
  jwtSecret: JWT_SECRET,
  scopes: [SCOPE_ROW],
  tokenScopes: new Map([[INGEST_TOKEN, { slug: 'english', id: SCOPE_ROW.id }]]),
  ownerTelegramUserId: OWNER_ID,
  initDataMaxAgeSeconds: 3600,
  jwtTtlSeconds: 900,
  db: stubDb,
  now: () => NOW,
}

function signInitData(fields: Record<string, string>, botToken: string): string {
  const params = new URLSearchParams(fields)
  const entries: Array<[string, string]> = []
  for (const [k, val] of params) {
    if (k !== 'hash') entries.push([k, val])
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const dataCheckString = entries.map(([k, val]) => `${k}=${val}`).join('\n')
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest()
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
  params.set('hash', hash)
  return params.toString()
}

function freshInitData(userId: number = OWNER_ID): string {
  return signInitData(
    {
      auth_date: String(Math.floor(NOW_MS / 1000)),
      query_id: 'AAH_test_query_id',
      user: JSON.stringify({ id: userId, first_name: 'T', username: 'tester' }),
    },
    BOT_TOKEN,
  )
}

describe('GET /health', () => {
  test('returns 200 with ok:true', async () => {
    const app = createApp(defaultDeps)
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('POST /auth/session', () => {
  test('issues a session JWT for a freshly-signed initData (Authorization tma)', async () => {
    const app = createApp(defaultDeps)
    const res = await app.request('/auth/session', {
      method: 'POST',
      headers: { authorization: `tma ${freshInitData()}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; expires_in: number; user: { id: number } }
    expect(body.expires_in).toBe(900)
    expect(body.user.id).toBe(OWNER_ID)
    const claims = await verifySession(body.token, JWT_SECRET, { now: NOW })
    expect(claims?.userId).toBe(OWNER_ID)
  })

  test('issues a session JWT for a freshly-signed initData (JSON body)', async () => {
    const app = createApp(defaultDeps)
    const res = await app.request('/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: freshInitData() }),
    })
    expect(res.status).toBe(200)
  })

  test('rejects with 400 when initData is missing entirely', async () => {
    const app = createApp(defaultDeps)
    const res = await app.request('/auth/session', { method: 'POST' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'missing_init_data' })
  })

  test('rejects with 401 when initData hash does not verify', async () => {
    const app = createApp(defaultDeps)
    const tampered = freshInitData().replace(/hash=[a-f0-9]+/, `hash=${'0'.repeat(64)}`)
    const res = await app.request('/auth/session', {
      method: 'POST',
      headers: { authorization: `tma ${tampered}` },
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'invalid_hash' })
  })

  test('rejects with 401 when auth_date is older than maxAge', async () => {
    const app = createApp(defaultDeps)
    const stale = signInitData(
      {
        auth_date: String(Math.floor(NOW_MS / 1000) - 3601),
        user: JSON.stringify({ id: OWNER_ID, first_name: 'X' }),
      },
      BOT_TOKEN,
    )
    const res = await app.request('/auth/session', {
      method: 'POST',
      headers: { authorization: `tma ${stale}` },
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'stale_auth_date' })
  })

  test('rejects with 403 when the Telegram user is not the configured owner', async () => {
    const app = createApp(defaultDeps)
    const other = freshInitData(OWNER_ID + 1)
    const res = await app.request('/auth/session', {
      method: 'POST',
      headers: { authorization: `tma ${other}` },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
  })

  test('rejects with 400 when JSON body is malformed', async () => {
    const app = createApp(defaultDeps)
    const res = await app.request('/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /auth/dev-token', () => {
  test('returns 404 by default (dev-auth gate is off)', async () => {
    const app = createApp(defaultDeps)
    const res = await app.request('/auth/dev-token')
    expect(res.status).toBe(404)
  })

  test('issues a JWT for OWNER_ID when enableDevAuth=true', async () => {
    const app = createApp({ ...defaultDeps, enableDevAuth: true })
    const res = await app.request('/auth/dev-token')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; expires_in: number }
    expect(body.expires_in).toBe(3600)
    const claims = await verifySession(body.token, JWT_SECRET, { now: NOW })
    expect(claims?.userId).toBe(OWNER_ID)
  })
})
