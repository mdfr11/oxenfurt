import * as v from 'valibot'

export const FsrsStateSchema = v.picklist([0, 1, 2, 3] as const)
export type FsrsState = v.InferOutput<typeof FsrsStateSchema>

export const FSRS_STATE = {
  New: 0,
  Learning: 1,
  Review: 2,
  Relearning: 3,
} as const satisfies Record<string, FsrsState>

export const FsrsCardStateSchema = v.object({
  fsrs_state: FsrsStateSchema,
  due: v.pipe(v.string(), v.isoTimestamp()),
  stability: v.number(),
  difficulty: v.number(),
  elapsed_days: v.number(),
  scheduled_days: v.number(),
  // Internal pointer into the current short-term step sequence. ts-fsrs needs
  // it preserved across calls or graduation from Learning never happens.
  learning_steps: v.pipe(v.number(), v.integer(), v.minValue(0)),
  reps: v.pipe(v.number(), v.integer(), v.minValue(0)),
  lapses: v.pipe(v.number(), v.integer(), v.minValue(0)),
  last_review: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
})
export type FsrsCardState = v.InferOutput<typeof FsrsCardStateSchema>
