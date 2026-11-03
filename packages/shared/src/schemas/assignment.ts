// Wire contract for agent-authored assignments. Input schemas are
// validated on the backend; the DTO interfaces below describe what the
// Mini App receives and are intentionally plain types (no runtime
// validation on the read path — same convention as DueCardDto).

import * as v from 'valibot'
import type { CardType, DueCardDto } from './card.ts'

export const GroupKindSchema = v.picklist(['topic', 'new', 'weak'] as const)
export type GroupKind = v.InferOutput<typeof GroupKindSchema>

export const ASSIGNMENT_MIN_ITEMS = 3
export const ASSIGNMENT_MAX_ITEMS = 30
/** Longest deadline the backend will accept, in days. Beyond this an
 *  "assignment" stops being a deliverable and becomes a backlog. */
export const ASSIGNMENT_MAX_DUE_DAYS = 30

const UuidSchema = v.pipe(v.string(), v.uuid())
const IsoDateSchema = v.pipe(v.string(), v.isoTimestamp())

export const AssignmentItemInputSchema = v.object({
  card_id: UuidSchema,
  group_label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  group_kind: GroupKindSchema,
})
export type AssignmentItemInput = v.InferOutput<typeof AssignmentItemInputSchema>

export const CreateAssignmentSchema = v.object({
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  rationale: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2000))),
  due_at: IsoDateSchema,
  source: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
  replace: v.optional(v.boolean(), false),
  items: v.pipe(
    v.array(AssignmentItemInputSchema),
    v.minLength(ASSIGNMENT_MIN_ITEMS),
    v.maxLength(ASSIGNMENT_MAX_ITEMS),
  ),
})
export type CreateAssignmentInput = v.InferOutput<typeof CreateAssignmentSchema>

export type AssignmentStatus = 'active' | 'completed' | 'expired'

export interface AssignmentGroupDto {
  label: string
  kind: GroupKind
  total: number
  completed: number
}

export interface AssignmentDto {
  id: string
  title: string
  rationale: string | null
  status: AssignmentStatus
  source: string | null
  created_at: string
  due_at: string
  completed_at: string | null
  /** Counts exclude items whose card has been archived. */
  completed: number
  total: number
  groups: AssignmentGroupDto[]
}

export interface AssignmentItemDto {
  card: DueCardDto
  group_label: string
  group_kind: GroupKind
  position: number
  completed_at: string | null
}

export interface ActiveAssignmentResponse {
  assignment: AssignmentDto | null
  items: AssignmentItemDto[]
}

/** One assignment by id, with its cards. Used by the history detail sheet
 *  and by drill sessions ("circles"), which replay a finished assignment
 *  outside the FSRS due queue. */
export interface AssignmentDetailResponse {
  assignment: AssignmentDto
  items: AssignmentItemDto[]
}

/** The most recently created assignment, whatever its status. Home uses it
 *  to keep a completed assignment on screen until its deadline, so the
 *  learner can replay it without digging into history. */
export interface LatestAssignmentResponse {
  assignment: AssignmentDto | null
}

export interface AssignmentListItemDto {
  id: string
  title: string
  status: AssignmentStatus
  due_at: string
  created_at: string
  completed_at: string | null
  completed: number
  total: number
}

export interface DiagnosticsCardDto {
  card_id: string
  type: CardType
  label: string
  source: string | null
  due: string
  days_overdue: number
  lapses: number
  reps: number
  difficulty: number
  stability: number
  last_review: string | null
}

export interface DiagnosticsSourceDto {
  source: string
  cards: number
  latest: string
}

export interface DiagnosticsLastAssignmentDto {
  id: string
  title: string
  status: AssignmentStatus
  due_at: string
  completed: number
  total: number
  unfinished_card_ids: string[]
}

export interface DiagnosticsResponse {
  summary: {
    active_cards: number
    overdue: number
    due_today: number
    leeches: number
  }
  overdue: DiagnosticsCardDto[]
  leeches: DiagnosticsCardDto[]
  fragile: DiagnosticsCardDto[]
  recent_sources: DiagnosticsSourceDto[]
  last_assignment: DiagnosticsLastAssignmentDto | null
}
