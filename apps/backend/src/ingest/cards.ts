import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import * as v from 'valibot'
import { FsrsService } from '@oxenfurt/shared'
import { IngestBatchSchema } from '@oxenfurt/shared'
import type { Db } from '../db/client.ts'
import { cards } from '../db/schema.ts'
import { ingestTokenAuth } from '../middleware/ingest-token.ts'

export interface IngestRouterDeps {
  db: Db
  ingestToken: string
  fsrs: FsrsService
  now?: () => Date
}

export interface IngestSummary {
  created: number
  skipped: number
}

export function createIngestRouter(deps: IngestRouterDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())

  app.use('*', ingestTokenAuth({ ingestToken: deps.ingestToken }))

  app.post('/cards', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_body' }, 400)
    }
    const parsed = v.safeParse(IngestBatchSchema, body)
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', issues: parsed.issues }, 400)
    }

    const summary = await ingestCards(deps.db, deps.fsrs, parsed.output, now())
    return c.json(summary)
  })

  return app
}

export async function ingestCards(
  db: Db,
  fsrs: FsrsService,
  batch: v.InferOutput<typeof IngestBatchSchema>,
  whenIngested: Date,
): Promise<IngestSummary> {
  let created = 0
  let skipped = 0

  for (const item of batch.cards) {
    const fsrsState = fsrs.createInitialState(whenIngested)
    const status: 'draft' | 'active' = item.type === 'vocab' ? 'active' : 'draft'
    const sourceQuote =
      'source_quote' in item && item.source_quote ? item.source_quote : null

    const values = {
      type: item.type,
      status,
      payload: item.payload,
      source: item.source ?? null,
      sourceQuote,
      fsrsState: fsrsState.fsrs_state,
      due: new Date(fsrsState.due),
      stability: fsrsState.stability,
      difficulty: fsrsState.difficulty,
      elapsedDays: fsrsState.elapsed_days,
      scheduledDays: fsrsState.scheduled_days,
      learningSteps: fsrsState.learning_steps,
      reps: fsrsState.reps,
      lapses: fsrsState.lapses,
      lastReview: fsrsState.last_review === null ? null : new Date(fsrsState.last_review),
    }

    if (item.type === 'vocab') {
      // Partial expressional unique index on (LOWER(payload->>'term')) WHERE type='vocab'.
      // Drizzle's onConflict API can't reference partial expressional indexes
      // cleanly, so we use raw SQL with the inference clause that matches.
      const result = await db.execute<{ id: string }>(sql`
        INSERT INTO cards (
          type, status, payload, source, source_quote,
          fsrs_state, due, stability, difficulty,
          elapsed_days, scheduled_days, learning_steps,
          reps, lapses, last_review
        ) VALUES (
          ${values.type}, ${values.status}, ${JSON.stringify(values.payload)}::jsonb,
          ${values.source}, ${values.sourceQuote},
          ${values.fsrsState}, ${values.due.toISOString()}, ${values.stability}, ${values.difficulty},
          ${values.elapsedDays}, ${values.scheduledDays}, ${values.learningSteps},
          ${values.reps}, ${values.lapses}, ${values.lastReview === null ? null : values.lastReview.toISOString()}
        )
        ON CONFLICT ((LOWER(payload->>'term'))) WHERE type = 'vocab'
        DO NOTHING
        RETURNING id
      `)
      if (result.length > 0) created++
      else skipped++
    } else {
      await db.insert(cards).values(values)
      created++
    }
  }

  return { created, skipped }
}
