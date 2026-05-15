import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import * as v from 'valibot'
import type { Db } from '../db/client.ts'
import { sessions } from '../db/schema.ts'
import { jwtAuth } from '../middleware/auth.ts'

export interface SessionsRouterDeps {
  db: Db
  jwtSecret: string
  now?: () => Date
}

const FinishBodySchema = v.object({
  cards_reviewed: v.pipe(v.number(), v.integer(), v.minValue(0)),
  cards_correct: v.pipe(v.number(), v.integer(), v.minValue(0)),
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function isUuid(s: string): boolean {
  return UUID_RE.test(s)
}

export function createSessionsRouter(deps: SessionsRouterDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())

  app.use('*', jwtAuth({ jwtSecret: deps.jwtSecret, now }))

  // Start a session. The client is free to ignore the response — if this
  // request fails (e.g. backend down) the practice flow still works locally
  // and just goes untracked.
  app.post('/', async (c) => {
    const [row] = await deps.db
      .insert(sessions)
      .values({ startedAt: now() })
      .returning({ id: sessions.id, startedAt: sessions.startedAt })
    return c.json({
      id: row!.id,
      started_at: row!.startedAt.toISOString(),
    })
  })

  // Finalise a session with the client-computed totals.
  // Once finished, the row is immutable — subsequent /finish returns 400.
  app.post('/:id/finish', async (c) => {
    const id = c.req.param('id')
    if (!isUuid(id)) return c.json({ error: 'invalid_id' }, 400)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_body' }, 400)
    }
    const parsed = v.safeParse(FinishBodySchema, body)
    if (!parsed.success) return c.json({ error: 'invalid_payload' }, 400)
    if (parsed.output.cards_correct > parsed.output.cards_reviewed) {
      return c.json({ error: 'invalid_payload' }, 400)
    }

    const result = await finishSession(
      deps.db,
      id,
      parsed.output.cards_reviewed,
      parsed.output.cards_correct,
      now(),
    )
    if (result === 'not_found') return c.json({ error: 'not_found' }, 404)
    if (result === 'already_finished') return c.json({ error: 'already_finished' }, 400)
    return c.json({
      id,
      finished_at: result.finishedAt.toISOString(),
      cards_reviewed: parsed.output.cards_reviewed,
      cards_correct: parsed.output.cards_correct,
    })
  })

  return app
}

export type FinishSessionResult =
  | { finishedAt: Date }
  | 'not_found'
  | 'already_finished'

export async function finishSession(
  db: Db,
  sessionId: string,
  cardsReviewed: number,
  cardsCorrect: number,
  finishedAt: Date,
): Promise<FinishSessionResult> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .for('update')
    if (row === undefined) return 'not_found'
    if (row.finishedAt !== null) return 'already_finished'

    await tx
      .update(sessions)
      .set({
        finishedAt,
        cardsReviewed,
        cardsCorrect,
      })
      .where(eq(sessions.id, sessionId))

    return { finishedAt }
  })
}
