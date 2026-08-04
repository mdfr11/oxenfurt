// Card → wire DTO for every read surface that hands a card to the practice
// screen: GET /cards/due and the assignment service both need the identical
// shape, so the mapper lives here rather than being copied.

import type { DueCardDto, FsrsCardState } from '@oxenfurt/shared'
import type { CardRow } from '../db/schema.ts'

export function toDueDto(row: CardRow, hasQuestions?: boolean): DueCardDto {
  const dto: DueCardDto = {
    id: row.id,
    type: row.type,
    payload: row.payload,
    source: row.source,
    source_quote: row.sourceQuote,
    fsrs: {
      fsrs_state: row.fsrsState as FsrsCardState['fsrs_state'],
      due: row.due.toISOString(),
      stability: row.stability,
      difficulty: row.difficulty,
      elapsed_days: row.elapsedDays,
      scheduled_days: row.scheduledDays,
      learning_steps: row.learningSteps,
      reps: row.reps,
      lapses: row.lapses,
      last_review: row.lastReview === null ? null : row.lastReview.toISOString(),
    },
  }
  if (hasQuestions) dto.has_questions = true
  return dto
}
