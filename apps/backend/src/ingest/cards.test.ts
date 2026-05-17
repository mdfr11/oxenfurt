import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { FsrsService } from '@oxenfurt/shared'
import { getTestDb, resetTestDb } from '../db/testing.ts'
import { cards } from '../db/schema.ts'
import { createIngestRouter, ingestCards } from './cards.ts'

const conn = await getTestDb()
const noDb = conn === null

const INGEST_TOKEN = 'test-ingest-token-1234567890'
const NOW = new Date('2026-01-01T12:00:00.000Z')
const fsrs = new FsrsService({ enableFuzz: false })

beforeEach(async () => {
  if (conn) await resetTestDb(conn.db)
})

// Don't close `conn` — shared singleton, see db/testing.ts.

describe.skipIf(noDb)('ingestCards (DB)', () => {
  test('inserts a vocab card with status=active and an initial FSRS state', async () => {
    const summary = await ingestCards(
      conn!.db,
      fsrs,
      {
        cards: [
          {
            type: 'vocab',
            payload: {
              term: 'get rid of',
              translation: 'избавиться от',
              context_sentence: 'You should get rid of that habit.',
              context_term_start: 11,
              context_term_end: 21,
            },
            source: 'Lesson 1, 02:30',
          },
        ],
      },
      NOW,
    )
    expect(summary).toEqual({ created: 1, skipped: 0 })
    const rows = await conn!.db.select().from(cards)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.type).toBe('vocab')
    expect(rows[0]!.status).toBe('active')
    expect(rows[0]!.fsrsState).toBe(0)
    expect(rows[0]!.reps).toBe(0)
  })

  test('inserts a theory card directly into the active queue', async () => {
    const summary = await ingestCards(
      conn!.db,
      fsrs,
      {
        cards: [
          {
            type: 'theory',
            payload: {
              question: 'When to use *in case* vs *if*?',
              answer:
                '*in case* prepares for a possible event; *if* states a condition.',
            },
            source: 'Lesson 12, 18:40',
            source_quote: 'Take an umbrella in case it rains.',
          },
        ],
      },
      NOW,
    )
    expect(summary).toEqual({ created: 1, skipped: 0 })
    const rows = await conn!.db.select().from(cards)
    expect(rows[0]!.status).toBe('active')
    expect(rows[0]!.sourceQuote).toBe('Take an umbrella in case it rains.')
  })

  test('dedupes vocab by case-insensitive term within a single batch', async () => {
    const make = (term: string, translation: string) => ({
      type: 'vocab' as const,
      payload: {
        term,
        translation,
        context_sentence: 'x',
        context_term_start: 0,
        context_term_end: term.length,
      },
    })
    const summary = await ingestCards(
      conn!.db,
      fsrs,
      { cards: [make('Get Rid Of', 'X'), make('get rid of', 'Y'), make('different', 'Z')] },
      NOW,
    )
    expect(summary).toEqual({ created: 2, skipped: 1 })
    const rows = await conn!.db.select().from(cards)
    expect(rows).toHaveLength(2)
  })

  test('vocab dedup persists across ingest batches', async () => {
    const term = {
      type: 'vocab' as const,
      payload: {
        term: 'persistence',
        translation: 'упорство',
        context_sentence: 'Persistence pays.',
        context_term_start: 0,
        context_term_end: 11,
      },
    }
    await ingestCards(conn!.db, fsrs, { cards: [term] }, NOW)
    const second = await ingestCards(conn!.db, fsrs, { cards: [term] }, NOW)
    expect(second).toEqual({ created: 0, skipped: 1 })
  })

  test('theory cards do not deduplicate', async () => {
    const theory = {
      type: 'theory' as const,
      payload: { question: 'Q', answer: 'A' },
      source_quote: 'quote',
    }
    await ingestCards(conn!.db, fsrs, { cards: [theory, theory] }, NOW)
    const rows = await conn!.db.select().from(cards).where(eq(cards.type, 'theory'))
    expect(rows).toHaveLength(2)
  })

  test('inserts a phrase card with status=active', async () => {
    const summary = await ingestCards(
      conn!.db,
      fsrs,
      {
        cards: [
          {
            type: 'phrase',
            payload: {
              phrase: 'take into account',
              translation: 'учитывать',
              context_sentence: "We'll take that into account.",
            },
            source: 'lesson-2026-05-15',
          },
        ],
      },
      NOW,
    )
    expect(summary).toEqual({ created: 1, skipped: 0 })
    const rows = await conn!.db.select().from(cards).where(eq(cards.type, 'phrase'))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('active')
    expect((rows[0]!.payload as { phrase: string }).phrase).toBe('take into account')
  })

  test('phrase dedup is case-insensitive', async () => {
    const mk = (phrase: string) => ({
      type: 'phrase' as const,
      payload: {
        phrase,
        translation: 't',
        context_sentence: 'x',
      },
    })
    const summary = await ingestCards(
      conn!.db,
      fsrs,
      { cards: [mk('On The Other Hand'), mk('on the other hand'), mk('by no means')] },
      NOW,
    )
    expect(summary).toEqual({ created: 2, skipped: 1 })
  })

  test('phrase dedup does NOT collapse internal whitespace differences', async () => {
    // The dedup index was originally regexp_replace-based to fold weird
    // spacing into one. We simplified to plain LOWER(phrase) in migration
    // 0004 so the ingest path's ON CONFLICT inference would actually
    // match the index. Internal-whitespace deduplication was the only
    // thing we gave up — Valibot already trims the outside, and
    // duplicated internal spaces in practice come from typos that the
    // operator can clean up via the Library's inline edit.
    const mk = (phrase: string) => ({
      type: 'phrase' as const,
      payload: { phrase, translation: 't', context_sentence: 'x' },
    })
    const summary = await ingestCards(
      conn!.db,
      fsrs,
      { cards: [mk('take  into   account'), mk('take into account')] },
      NOW,
    )
    expect(summary).toEqual({ created: 2, skipped: 0 })
  })

  test('phrase dedup persists across separate ingest batches', async () => {
    const p = {
      type: 'phrase' as const,
      payload: {
        phrase: 'by all means',
        translation: 'безусловно',
        context_sentence: 'By all means, go ahead.',
      },
    }
    await ingestCards(conn!.db, fsrs, { cards: [p] }, NOW)
    const second = await ingestCards(conn!.db, fsrs, { cards: [p] }, NOW)
    expect(second).toEqual({ created: 0, skipped: 1 })
  })

  test('vocab and phrase use SEPARATE uniqueness namespaces', async () => {
    // Same string can be both a vocab term and a phrase — they live in
    // different dedup spaces. Practically rare but the index is partial.
    await ingestCards(
      conn!.db,
      fsrs,
      {
        cards: [
          {
            type: 'vocab',
            payload: {
              term: 'go',
              translation: 'идти',
              context_sentence: 'Go away.',
              context_term_start: 0,
              context_term_end: 2,
            },
          },
        ],
      },
      NOW,
    )
    const result = await ingestCards(
      conn!.db,
      fsrs,
      {
        cards: [
          {
            type: 'phrase',
            payload: {
              phrase: 'go away',
              translation: 'уходи',
              context_sentence: 'Just go away.',
            },
          },
        ],
      },
      NOW,
    )
    expect(result).toEqual({ created: 1, skipped: 0 })
  })

  test('mixed batch — vocab, phrase, theory — all land correctly', async () => {
    const summary = await ingestCards(
      conn!.db,
      fsrs,
      {
        cards: [
          {
            type: 'vocab',
            payload: {
              term: 'pragmatic',
              translation: 'прагматичный',
              context_sentence: 'A pragmatic choice.',
              context_term_start: 2,
              context_term_end: 11,
            },
          },
          {
            type: 'phrase',
            payload: {
              phrase: 'pay attention',
              translation: 'обращать внимание',
              context_sentence: 'Pay attention to detail.',
            },
          },
          {
            type: 'theory',
            payload: { question: 'When?', answer: 'Always.' },
            source_quote: 'always',
          },
        ],
      },
      NOW,
    )
    expect(summary).toEqual({ created: 3, skipped: 0 })
    const rows = await conn!.db.select().from(cards)
    expect(rows.map((r) => r.type).sort()).toEqual(['phrase', 'theory', 'vocab'])
  })
})

describe.skipIf(noDb)('POST /ingest/cards (HTTP)', () => {
  const buildApp = () =>
    createIngestRouter({
      db: conn!.db,
      ingestToken: INGEST_TOKEN,
      fsrs,
      now: () => NOW,
    })

  test('returns 401 without the Bearer token', async () => {
    const res = await buildApp().request('/cards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cards: [] }),
    })
    expect(res.status).toBe(401)
  })

  test('returns 400 for malformed JSON body', async () => {
    const res = await buildApp().request('/cards', {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/json' },
      body: 'not-json',
    })
    expect(res.status).toBe(400)
  })

  test('returns 400 when payload fails Valibot validation', async () => {
    const res = await buildApp().request('/cards', {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cards: [{ type: 'vocab', payload: { term: '' } }] }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 200 with summary for a valid batch', async () => {
    const res = await buildApp().request('/cards', {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        cards: [
          {
            type: 'vocab',
            payload: {
              term: 'http',
              translation: 'http',
              context_sentence: 'http is a protocol',
              context_term_start: 0,
              context_term_end: 4,
            },
          },
        ],
      }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ created: 1, skipped: 0 })
  })
})
