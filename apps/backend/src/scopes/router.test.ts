// Cross-scope isolation — the guarantee the whole scopes feature exists
// to provide. Everything else (pills, accents) is presentation; these
// tests pin the boundaries:
//
//   1. An agent token writes ONLY into its own scope.
//   2. A user reading with X-Scope sees ONLY that scope's deck.
//   3. Dedup, the active-assignment slot and stats are all per-scope.
//   4. The default scope absorbs requests without an X-Scope header.
//
// Built on createApp rather than individual routers, because the token →
// scope and header → scope resolution lives in middleware wiring.

import { beforeEach, describe, expect, test } from 'bun:test'
import { signSession } from '../auth/jwt.ts'
import { getTestDb, resetTestDb } from '../db/testing.ts'
import { parseScopesConfig, syncScopes } from '../db/scopes.ts'
import { toScopeRef } from '../middleware/scope.ts'
import type { ScopeRow } from '../db/schema.ts'
import { createApp } from '../server/app.ts'
import type { ScopesResponse } from '@oxenfurt/shared'

const conn = await getTestDb()
const noDb = conn === null

const JWT_SECRET = '0123456789abcdef0123456789abcdef-test'
const BOT_TOKEN = '1234567890:ABCDEF_test_bot_token'
const OWNER_ID = 99
const NOW = new Date('2026-11-01T12:00:00.000Z')

const ENGLISH_TOKEN = 'token-english-aaaaaaaaaaaaaa'
const GO_TOKEN = 'token-golang-bbbbbbbbbbbbbb'

let english: ScopeRow
let go: ScopeRow

beforeEach(async () => {
  if (!conn) return
  await resetTestDb(conn.db)
  const rows = await syncScopes(conn.db, parseScopesConfig('english:English:🇬🇧:indigo,go:Go:🐹:emerald'))
  english = rows[0]!
  go = rows[1]!
})

function app() {
  return createApp({
    botToken: BOT_TOKEN,
    jwtSecret: JWT_SECRET,
    scopes: [english, go],
    tokenScopes: new Map([
      [ENGLISH_TOKEN, toScopeRef(english)],
      [GO_TOKEN, toScopeRef(go)],
    ]),
    ownerTelegramUserId: OWNER_ID,
    initDataMaxAgeSeconds: 3600,
    jwtTtlSeconds: 900,
    db: conn!.db,
    now: () => NOW,
  })
}

async function auth(scope?: string): Promise<Record<string, string>> {
  const token = await signSession({ userId: OWNER_ID }, JWT_SECRET, { ttlSeconds: 900, now: NOW })
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (scope !== undefined) headers['x-scope'] = scope
  return headers
}

function agentPost(token: string, body: unknown, path = '/ingest/cards') {
  return app().request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function vocab(term: string, source = 'lesson-1') {
  return {
    cards: [
      {
        type: 'vocab' as const,
        payload: {
          term,
          translation: 'перевод',
          context_sentence: `A sentence with ${term} inside.`,
          context_term_start: 16,
          context_term_end: 16 + term.length,
        },
        source,
      },
    ],
  }
}

describe.skipIf(noDb)('scope isolation', () => {
  test('an agent token writes only into its own scope', async () => {
    const res = await agentPost(GO_TOKEN, vocab('goroutine'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ created: 1, skipped: 0 })

    const goCards = await app().request('/cards/due', { headers: await auth('go') })
    const englishCards = await app().request('/cards/due', { headers: await auth('english') })
    expect((((await goCards.json()) as { cards: unknown[] }).cards)).toHaveLength(1)
    expect((((await englishCards.json()) as { cards: unknown[] }).cards)).toHaveLength(0)
  })

  test('a wrong agent token gets 401 and writes nothing', async () => {
    const res = await agentPost('token-impostor-cccccccccc', vocab('goroutine'))
    expect(res.status).toBe(401)
    const body = (await (await app().request('/cards/due', { headers: await auth('go') })).json()) as {
      cards: unknown[]
    }
    expect(body.cards).toHaveLength(0)
  })

  test('the same term is a legitimate different card in two scopes', async () => {
    await agentPost(ENGLISH_TOKEN, vocab('culture'))
    await agentPost(GO_TOKEN, vocab('culture'))

    for (const slug of ['english', 'go']) {
      const body = (await (
        await app().request('/cards/due', { headers: await auth(slug) })
      ).json()) as { cards: unknown[] }
      expect(body.cards).toHaveLength(1)
    }
  })

  test('the active-assignment slot is per scope', async () => {
    for (const term of ['pragmatic', 'sturdy', 'vivid']) await agentPost(ENGLISH_TOKEN, vocab(term))
    for (const term of ['goroutine', 'channel', 'mutex', 'defer']) await agentPost(GO_TOKEN, vocab(term))

    const dueOf = async (slug: string) =>
      ((await (await app().request('/cards/due', { headers: await auth(slug) })).json()) as {
        cards: Array<{ id: string; payload: { term: string } }>
      }).cards
    const englishCards = await dueOf('english')
    const goCards = await dueOf('go')

    const dueAt = new Date(NOW.getTime() + 24 * 3600 * 1000).toISOString()
    const mk = (title: string, ids: string[]) => ({
      title,
      rationale: 'why',
      due_at: dueAt,
      items: ids.map((card_id) => ({ card_id, group_label: 'Новое', group_kind: 'new' })),
    })

    const first = await agentPost(
      ENGLISH_TOKEN,
      mk('English assignment', englishCards.map((c) => c.id)),
      '/agent/assignments',
    )
    expect(first.status).toBe(200)
    // A live english assignment does NOT block the go slot.
    const second = await agentPost(
      GO_TOKEN,
      mk('Go assignment', goCards.slice(0, 3).map((c) => c.id)),
      '/agent/assignments',
    )
    expect(second.status).toBe(200)

    // And the same slot still rejects a second assignment in that scope.
    const conflict = await agentPost(
      GO_TOKEN,
      mk('Go assignment 2', goCards.slice(1, 4).map((c) => c.id)),
      '/agent/assignments',
    )
    expect(conflict.status).toBe(409)
  })

  test('an agent cannot compose an assignment from another scope card', async () => {
    for (const term of ['pragmatic', 'sturdy', 'vivid']) await agentPost(ENGLISH_TOKEN, vocab(term))
    const englishCards = ((await (
      await app().request('/cards/due', { headers: await auth('english') })
    ).json()) as { cards: Array<{ id: string }> }).cards

    const res = await agentPost(
      GO_TOKEN,
      {
        title: 'Cross-scope',
        due_at: new Date(NOW.getTime() + 24 * 3600 * 1000).toISOString(),
        items: englishCards.map((c) => ({ card_id: c.id, group_label: 'Новое', group_kind: 'new' })),
      },
      '/agent/assignments',
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'unknown_cards' })
  })

  test('unknown X-Scope is a 400, missing X-Scope falls back to the default', async () => {
    await agentPost(ENGLISH_TOKEN, vocab('pragmatic'))

    const rejected = await app().request('/cards/due', { headers: await auth('typo-scope') })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toEqual({ error: 'unknown_scope' })

    // No header at all → default (first configured) scope, so pre-scope
    // clients keep working.
    const fallback = await app().request('/cards/due', { headers: await auth() })
    const body = (await fallback.json()) as { cards: unknown[] }
    expect(body.cards).toHaveLength(1)
  })

  test('GET /scopes lists summaries with per-scope due counts', async () => {
    await agentPost(ENGLISH_TOKEN, vocab('pragmatic'))
    await agentPost(GO_TOKEN, vocab('goroutine'))
    await agentPost(GO_TOKEN, vocab('mutex'))

    const res = await app().request('/scopes', { headers: await auth() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as ScopesResponse
    expect(body.scopes).toHaveLength(2)
    const englishSummary = body.scopes.find((s) => s.slug === 'english')!
    const goSummary = body.scopes.find((s) => s.slug === 'go')!
    expect(englishSummary.due_count).toBe(1)
    expect(goSummary.due_count).toBe(2)
    expect(goSummary.accent).toBe('emerald')
    expect(goSummary.has_active_assignment).toBe(false)
  })

  test('reviews and stats stay inside their scope', async () => {
    await agentPost(ENGLISH_TOKEN, vocab('pragmatic'))
    await agentPost(GO_TOKEN, vocab('goroutine'))

    const goCard = ((await (
      await app().request('/cards/due', { headers: await auth('go') })
    ).json()) as { cards: Array<{ id: string }> }).cards[0]!

    await app().request(`/cards/${goCard.id}/review`, {
      method: 'POST',
      headers: { ...(await auth('go')), 'content-type': 'application/json' },
      body: JSON.stringify({ rating: 4 }),
    })

    const goStats = (await (
      await app().request('/stats/today', { headers: await auth('go') })
    ).json()) as { reviewedToday: number; dueCount: number }
    const englishStats = (await (
      await app().request('/stats/today', { headers: await auth('english') })
    ).json()) as { reviewedToday: number; dueCount: number }

    expect(goStats.reviewedToday).toBe(1)
    expect(englishStats.reviewedToday).toBe(0)
    expect(goStats.dueCount).toBe(0)
    expect(englishStats.dueCount).toBe(1)
  })

  test('a card of another scope is not_found to a scoped client', async () => {
    await agentPost(ENGLISH_TOKEN, vocab('pragmatic'))
    const card = ((await (
      await app().request('/cards/due', { headers: await auth('english') })
    ).json()) as { cards: Array<{ id: string }> }).cards[0]!

    // Same authenticated user, wrong scope context: the card does not
    // exist as far as this request is concerned.
    const res = await app().request(`/cards/${card.id}/archive`, {
      method: 'POST',
      headers: await auth('go'),
    })
    expect(res.status).toBe(404)
  })
})
