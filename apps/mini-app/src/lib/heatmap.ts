// Pure helpers for the heatmap views — both the compact 12-week
// strip on Home and the full 26-week grid on Stats project a
// `{date, count}[]` history onto a calendar of cells. The grid
// rendering differs (cell size, gap, day-of-week alignment, legend),
// but the "build N days of cells anchored to today with counts pulled
// from a map" step is identical and worth sharing — plus it's easier
// to unit test in isolation than to test through React.

/** Calendar cell ready to render. Distinct from the backend's
 *  `HeatmapCell` DTO in `@oxenfurt/shared` (which is just `{date, count}`)
 *  — this one carries the layout fields the grid components need. */
export interface HeatmapGridCell {
  date: string // ISO yyyy-mm-dd, anchored to UTC
  count: number
  /** 0..6, Sunday = 0. Used by Stats to align columns by week; Home
   *  ignores this and lays cells out sequentially. */
  dow: number
  /** True when the cell sits past `anchorAt` — happens for the trailing
   *  cells of the final week. Stats renders these transparent. */
  isFuture: boolean
}

export interface BuildHeatmapCellsArgs {
  history: Array<{ date: string; count: number }>
  /** Number of weeks (columns). 12 on Home, 26 on Stats. */
  weeks: number
  /** "Today" — usually `new Date()` or the backend's `generated_at`
   *  so the heatmap edge is stable across re-renders. */
  anchorAt: Date
}

const DAY_MS = 24 * 3600 * 1000

export function buildHeatmapCells({
  history,
  weeks,
  anchorAt,
}: BuildHeatmapCellsArgs): HeatmapGridCell[] {
  const counts = new Map<string, number>()
  for (const h of history) counts.set(h.date, h.count)

  // Snap to UTC midnight so the same `anchorAt` produces the same grid
  // regardless of the caller's timezone.
  const lastDay = new Date(
    Date.UTC(anchorAt.getUTCFullYear(), anchorAt.getUTCMonth(), anchorAt.getUTCDate()),
  )
  const totalDays = weeks * 7
  const firstDay = new Date(lastDay.getTime() - (totalDays - 1) * DAY_MS)

  const cells: HeatmapGridCell[] = []
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(firstDay.getTime() + i * DAY_MS)
    const iso = d.toISOString().slice(0, 10)
    cells.push({
      date: iso,
      count: counts.get(iso) ?? 0,
      dow: d.getUTCDay(),
      isFuture: d > lastDay,
    })
  }
  return cells
}
