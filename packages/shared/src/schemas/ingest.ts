import * as v from 'valibot'
import { VocabPayloadSchema, TheoryPayloadSchema, PhrasePayloadSchema } from './card.ts'

const SourceSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))
const SourceQuoteSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000))

export const VocabIngestSchema = v.object({
  type: v.literal('vocab'),
  payload: VocabPayloadSchema,
  source: v.optional(SourceSchema),
  source_quote: v.optional(SourceQuoteSchema),
})
export type VocabIngest = v.InferOutput<typeof VocabIngestSchema>

export const TheoryIngestSchema = v.object({
  type: v.literal('theory'),
  payload: TheoryPayloadSchema,
  source: v.optional(SourceSchema),
  source_quote: SourceQuoteSchema,
})
export type TheoryIngest = v.InferOutput<typeof TheoryIngestSchema>

export const PhraseIngestSchema = v.object({
  type: v.literal('phrase'),
  payload: PhrasePayloadSchema,
  source: v.optional(SourceSchema),
  source_quote: v.optional(SourceQuoteSchema),
})
export type PhraseIngest = v.InferOutput<typeof PhraseIngestSchema>

export const IngestCardSchema = v.variant('type', [VocabIngestSchema, TheoryIngestSchema, PhraseIngestSchema])
export type IngestCard = v.InferOutput<typeof IngestCardSchema>

export const IngestBatchSchema = v.object({
  cards: v.pipe(v.array(IngestCardSchema), v.minLength(1), v.maxLength(500)),
})
export type IngestBatch = v.InferOutput<typeof IngestBatchSchema>
