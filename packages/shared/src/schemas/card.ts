import * as v from 'valibot'
import { type FsrsCardState } from './fsrs.ts'

export const CardTypeSchema = v.picklist(['vocab', 'theory', 'phrase'])
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

// Multi-word lexical units — collocations ("take into account"), idioms
// ("by no means"), fixed expressions ("on the other hand"). Distinct from
// vocab so cloze can blank mid-phrase words, translation matching can be
// word-aware, and the card renderer can lay them out for multiple lines.
//
// `pattern` is optional — the canonical form with slot markers, e.g.
// "to take {sth} into account". When present, used as the prompt for
// cloze-style practice instead of blanking a random word.
export const PhrasePayloadSchema = v.object({
  phrase: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(300)),
  translation: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  context_sentence: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000)),
  pattern: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300))),
})
export type PhrasePayload = v.InferOutput<typeof PhrasePayloadSchema>

// Inline-edit payload schemas. Client sends just the user-editable fields;
// the server recomputes term offsets from the (possibly edited) term and
// context_sentence so the cloze renderer stays valid.
//
// `context_sentence` is intentionally optional / allowed-empty on the edit
// path: a user editing a card from the cabinet (EditCardSheet) may not
// have a natural sentence to attach, and the practice surfaces degrade
// gracefully when one isn't present (vocab cloze falls back to
// recognition, the sentence-quote block is hidden). Ingest still requires
// a sentence — that constraint lives on VocabPayloadSchema /
// PhrasePayloadSchema, not here.
export const VocabUpdateInputSchema = v.object({
  term: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  translation: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  context_sentence: v.pipe(v.string(), v.trim(), v.maxLength(2000)),
})
export type VocabUpdateInput = v.InferOutput<typeof VocabUpdateInputSchema>

export const TheoryUpdateInputSchema = v.object({
  question: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  answer: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000)),
})
export type TheoryUpdateInput = v.InferOutput<typeof TheoryUpdateInputSchema>

export const PhraseUpdateInputSchema = v.object({
  phrase: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(300)),
  translation: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  context_sentence: v.pipe(v.string(), v.trim(), v.maxLength(2000)),
  pattern: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300))),
})
export type PhraseUpdateInput = v.InferOutput<typeof PhraseUpdateInputSchema>

export const CardUpdateInputSchema = v.variant('type', [
  v.object({ type: v.literal('vocab'), payload: VocabUpdateInputSchema }),
  v.object({ type: v.literal('theory'), payload: TheoryUpdateInputSchema }),
  v.object({ type: v.literal('phrase'), payload: PhraseUpdateInputSchema }),
])
export type CardUpdateInput = v.InferOutput<typeof CardUpdateInputSchema>

export interface DueCardDto {
  id: string
  type: CardType
  payload: VocabPayload | TheoryPayload | PhrasePayload
  source: string | null
  source_quote: string | null
  fsrs: FsrsCardState
  has_questions?: boolean
}

export interface CardListDto {
  id: string
  type: CardType
  status: 'active' | 'archived' | 'draft'
  payload: VocabPayload | TheoryPayload | PhrasePayload
  source: string | null
  source_quote: string | null
  created_at: string
  due: string
  reps: number
  lapses: number
  has_questions?: boolean
}

export interface CardListResponse {
  cards: CardListDto[]
  total: number
}
