import { describe, expect, test } from 'bun:test'
import { buildHeatmapCells } from './heatmap'

const T = (iso: string) => new Date(iso)

describe('buildHeatmapCells', () => {
  test('emits weeks*7 cells', () => {
    const cells = buildHeatmapCells({
      history: [],
      weeks: 12,
      anchorAt: T('2026-05-17T00:00:00.000Z'),
    })
    expect(cells).toHaveLength(84)
  })

  test('cells are sequential, oldest first', () => {
    const cells = buildHeatmapCells({
      history: [],
      weeks: 2,
      anchorAt: T('2026-05-17T00:00:00.000Z'),
    })
    expect(cells[0]!.date).toBe('2026-05-04')
    expect(cells[cells.length - 1]!.date).toBe('2026-05-17')
  })

  test('counts from history land on the right cells, missing days default to 0', () => {
    const cells = buildHeatmapCells({
      history: [
        { date: '2026-05-10', count: 7 },
        { date: '2026-05-15', count: 3 },
      ],
      weeks: 2,
      anchorAt: T('2026-05-17T00:00:00.000Z'),
    })
    const byDate = new Map(cells.map((c) => [c.date, c.count]))
    expect(byDate.get('2026-05-10')).toBe(7)
    expect(byDate.get('2026-05-15')).toBe(3)
    expect(byDate.get('2026-05-04')).toBe(0)
    expect(byDate.get('2026-05-17')).toBe(0)
  })

  test('dow is 0..6 with Sunday = 0', () => {
    // 2026-05-17 is a Sunday → dow=0.
    const cells = buildHeatmapCells({
      history: [],
      weeks: 1,
      anchorAt: T('2026-05-17T00:00:00.000Z'),
    })
    const last = cells[cells.length - 1]!
    expect(last.date).toBe('2026-05-17')
    expect(last.dow).toBe(0)
    // The day before should be Saturday (6).
    expect(cells[cells.length - 2]!.dow).toBe(6)
  })

  test('isFuture is false for every cell when anchor is today', () => {
    const cells = buildHeatmapCells({
      history: [],
      weeks: 2,
      anchorAt: T('2026-05-17T00:00:00.000Z'),
    })
    expect(cells.every((c) => !c.isFuture)).toBe(true)
  })

  test('anchorAt non-UTC times are snapped to UTC midnight', () => {
    // Two anchors on the same UTC day but different times → same grid.
    const a = buildHeatmapCells({
      history: [],
      weeks: 1,
      anchorAt: T('2026-05-17T03:00:00.000Z'),
    })
    const b = buildHeatmapCells({
      history: [],
      weeks: 1,
      anchorAt: T('2026-05-17T22:00:00.000Z'),
    })
    expect(a.map((c) => c.date)).toEqual(b.map((c) => c.date))
  })
})
