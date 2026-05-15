import * as v from 'valibot'
import { type FsrsCardState } from './fsrs.ts'

export const CardTypeSchema = v.picklist(['vocab', 'theory'])
export type CardType = v.InferOutput<typeof CardTypeSchema>

export const CardStatusSchema = v.picklist(['draft', 'active', 'archived'])
export type CardStatus = v.InferOutput<typeof CardStatusSchema>

export const VocabPayloadSchema = v.object({
  term: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  translation: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  context_sentence: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000)),
  context_term_start: v.pipe(v.number(), v.integer(), v.minValue(0)),
  context_term_end: v.pipe(v.number(), v.integer(), v.minValue(0)),
})
export type VocabPayload = v.InferOutput<typeof VocabPayloadSchema>

export const TheoryPayloadSchema = v.object({
  question: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  answer: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000)),
})
export type TheoryPayload = v.InferOutput<typeof TheoryPayloadSchema>

export interface DueCardDto {
  id: string
  type: 'vocab' | 'theory'
  payload: VocabPayload | TheoryPayload
  source: string | null
  source_quote: string | null
  fsrs: FsrsCardState
}

export interface CardListDto {
  id: string
  type: 'vocab' | 'theory'
  status: 'active' | 'archived' | 'draft'
  payload: VocabPayload | TheoryPayload
  source: string | null
  source_quote: string | null
  created_at: string
  due: string
  reps: number
  lapses: number
}

export interface CardListResponse {
  cards: CardListDto[]
  total: number
}
