import * as v from 'valibot'

export const RatingSchema = v.picklist([1, 2, 3, 4] as const)
export type Rating = v.InferOutput<typeof RatingSchema>

export const RATING = {
  Again: 1,
  Hard: 2,
  Good: 3,
  Easy: 4,
} as const satisfies Record<string, Rating>
