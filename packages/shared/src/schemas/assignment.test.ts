import { describe, expect, test } from 'bun:test'
import * as v from 'valibot'
import { CreateAssignmentSchema } from './assignment.ts'

const CARD_A = '11111111-1111-4111-8111-111111111111'
const CARD_B = '22222222-2222-4222-8222-222222222222'
const CARD_C = '33333333-3333-4333-8333-333333333333'

function item(cardId: string) {
  return { card_id: cardId, group_label: 'Второй кондиционал', group_kind: 'topic' as const }
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Условные предложения и лексика 28 июля',
    due_at: '2026-08-06T21:00:00.000Z',
    items: [item(CARD_A), item(CARD_B), item(CARD_C)],
    ...overrides,
  }
}

describe('CreateAssignmentSchema', () => {
  test('accepts a minimal valid assignment', () => {
    const parsed = v.safeParse(CreateAssignmentSchema, base())
    expect(parsed.success).toBe(true)
  })

  test('defaults replace to false', () => {
    const parsed = v.parse(CreateAssignmentSchema, base())
    expect(parsed.replace).toBe(false)
  })

  test('rejects fewer than 3 items', () => {
    const parsed = v.safeParse(CreateAssignmentSchema, base({ items: [item(CARD_A), item(CARD_B)] }))
    expect(parsed.success).toBe(false)
  })

  test('rejects more than 30 items', () => {
    const items = Array.from({ length: 31 }, () => item(CARD_A))
    const parsed = v.safeParse(CreateAssignmentSchema, base({ items }))
    expect(parsed.success).toBe(false)
  })

  test('rejects an empty title', () => {
    expect(v.safeParse(CreateAssignmentSchema, base({ title: '   ' })).success).toBe(false)
  })

  test('rejects a title longer than 120 chars', () => {
    expect(v.safeParse(CreateAssignmentSchema, base({ title: 'x'.repeat(121) })).success).toBe(false)
  })

  test('rejects an unknown group_kind', () => {
    const bad = [{ card_id: CARD_A, group_label: 'X', group_kind: 'bonus' }]
    expect(v.safeParse(CreateAssignmentSchema, base({ items: bad })).success).toBe(false)
  })

  test('rejects a non-uuid card_id', () => {
    const bad = [item(CARD_A), item(CARD_B), { ...item(CARD_C), card_id: 'nope' }]
    expect(v.safeParse(CreateAssignmentSchema, base({ items: bad })).success).toBe(false)
  })

  test('rejects a malformed due_at', () => {
    expect(v.safeParse(CreateAssignmentSchema, base({ due_at: 'tomorrow' })).success).toBe(false)
  })

  test('accepts rationale up to 2000 chars and rejects beyond', () => {
    expect(v.safeParse(CreateAssignmentSchema, base({ rationale: 'a'.repeat(2000) })).success).toBe(true)
    expect(v.safeParse(CreateAssignmentSchema, base({ rationale: 'a'.repeat(2001) })).success).toBe(false)
  })
})
