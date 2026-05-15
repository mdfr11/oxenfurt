import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { backButton } from '@telegram-apps/sdk-react'
import { Spinner } from '@telegram-apps/telegram-ui'
import { ArrowLeft } from 'lucide-react'
import type { HeatmapCell, RecentSession, StatsResponse } from '@oxenfurt/shared'
import { fetchWithAuth } from '../lib/api'

interface StatsProps {
  onExit: () => void
}

export function Stats({ onExit }: StatsProps) {
  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    try {
      backButton.show()
      unsubscribe = backButton.onClick(onExit)
    } catch {
      // dev — fine
    }
    return () => {
      try {
        unsubscribe?.()
        backButton.hide()
      } catch {
        // ditto
      }
    }
  }, [onExit])

  const { data, isLoading, error } = useQuery({
    queryKey: ['sessions', 'stats'],
    queryFn: async () => {
      const res = await fetchWithAuth('/sessions/stats')
      if (!res.ok) throw new Error(`stats fetch failed: ${res.status}`)
      return (await res.json()) as StatsResponse
    },
  })

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-app-bg">
        <Spinner size="l" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center bg-app-bg text-app-text">
        <h2 className="text-xl font-bold mb-2">Не удалось загрузить</h2>
        <p className="text-xs text-app-hint mb-6">{error instanceof Error ? error.message : 'unknown'}</p>
        <button onClick={onExit} className="text-app-link font-semibold">Назад</button>
      </div>
    )
  }

  const todayAcc = accuracy(data.reviews.today)
  const weekAcc = accuracy(data.reviews.last_7d)
  const monthAcc = accuracy(data.reviews.last_30d)

  return (
    <div
      className="flex-1 flex flex-col h-full w-full min-h-0 bg-app-bg text-app-text overflow-y-auto"
      style={{
        paddingTop: `calc(0.75rem + var(--tg-safe-area-inset-top, 0px))`,
        paddingBottom: `calc(1rem + var(--tg-safe-area-inset-bottom, 0px))`,
      }}
    >
      {/* Header */}
      <div className="px-4 pb-4 flex items-center gap-3">
        <button
          onClick={onExit}
          className="w-10 h-10 flex items-center justify-center rounded-full bg-app-surface border border-app-border active:scale-90 transition-transform"
          aria-label="Назад"
        >
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-xl font-bold leading-none flex-1">Статистика</h1>
      </div>

      <div className="px-4 flex flex-col gap-4">
        {/* Top numbers */}
        <div className="grid grid-cols-3 gap-2">
          <StatCard label="Сегодня" count={data.reviews.today.count} sub={todayAcc} />
          <StatCard label="За 7 дней" count={data.reviews.last_7d.count} sub={weekAcc} />
          <StatCard label="За 30 дней" count={data.reviews.last_30d.count} sub={monthAcc} />
        </div>

        {/* Forecast */}
        <div className="bg-app-surface border border-app-border rounded-2xl p-4 flex justify-around">
          <ForecastCell label="Готовы сейчас" value={data.forecast.due_now} accent />
          <ForecastCell label="В ближайшие 24ч" value={data.forecast.due_next_24h} />
          <ForecastCell label="Всего активных" value={data.forecast.active_total} />
        </div>

        {/* Heatmap */}
        <div>
          <h2 className="text-[11px] uppercase tracking-widest text-app-hint font-bold mb-2 px-1">
            Активность
          </h2>
          <Heatmap heatmap={data.heatmap} generatedAt={data.generated_at} />
        </div>

        {/* Recent sessions */}
        <div>
          <h2 className="text-[11px] uppercase tracking-widest text-app-hint font-bold mb-2 px-1">
            Последние сессии
          </h2>
          {data.recent_sessions.length === 0 ? (
            <p className="text-xs text-app-hint px-1">Сессий пока не было</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {data.recent_sessions.map((s) => (
                <li key={s.id}>
                  <SessionRow session={s} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function accuracy({ count, correct }: { count: number; correct: number }): string {
  if (count === 0) return '—'
  return `${Math.round((correct / count) * 100)}%`
}

function StatCard({ label, count, sub }: { label: string; count: number; sub: string }) {
  return (
    <div className="bg-app-surface border border-app-border rounded-2xl p-3 flex flex-col">
      <div className="text-[9px] uppercase tracking-wider text-app-hint font-bold">{label}</div>
      <div className="text-2xl font-bold mt-0.5">{count}</div>
      <div className="text-[10px] text-app-hint mt-0.5">точность {sub}</div>
    </div>
  )
}

function ForecastCell({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className={`text-2xl font-bold ${accent ? 'text-app-primary' : 'text-app-text'}`}>
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-app-hint font-bold mt-1 max-w-[80px]">
        {label}
      </div>
    </div>
  )
}

function SessionRow({ session }: { session: RecentSession }) {
  const acc = session.cards_reviewed > 0
    ? Math.round((session.cards_correct / session.cards_reviewed) * 100)
    : 0
  return (
    <div className="bg-app-surface border border-app-border rounded-xl px-4 py-2.5 flex items-center justify-between">
      <div className="text-sm">
        <div className="font-semibold">{formatDate(session.finished_at)}</div>
        <div className="text-[11px] text-app-hint mt-0.5">{formatTime(session.finished_at)}</div>
      </div>
      <div className="text-right">
        <div className="text-sm font-semibold">{session.cards_reviewed} карточек</div>
        <div className="text-[11px] text-app-hint mt-0.5">{acc}% точности</div>
      </div>
    </div>
  )
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 24 * 3600 * 1000)
  if (sameDay(d, today)) return 'Сегодня'
  if (sameDay(d, yesterday)) return 'Вчера'
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
}

// --- Heatmap ---

const WEEKS = 26 // ~6 months visible by default; scroll horizontally for more
const CELL_PX = 12
const GAP_PX = 2

function Heatmap({ heatmap, generatedAt }: { heatmap: HeatmapCell[]; generatedAt: string }) {
  // Build a Map for O(1) lookup, then iterate calendar days.
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of heatmap) m.set(c.date, c.count)
    return m
  }, [heatmap])

  // Anchor the grid to "today" in UTC — backend dates are UTC, day boundaries
  // might be slightly off the user's local time but that's acceptable for a
  // single-user app.
  const today = useMemo(() => new Date(generatedAt), [generatedAt])
  const totalDays = WEEKS * 7

  // Find the most recent Sunday so columns align by week.
  const lastDay = new Date(Date.UTC(
    today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(),
  ))
  const firstDay = new Date(lastDay.getTime() - (totalDays - 1) * 24 * 3600 * 1000)

  // Generate (col, row, date, count) for every cell.
  const cells: Array<{ col: number; row: number; date: string; count: number; isFuture: boolean }> = []
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(firstDay.getTime() + i * 24 * 3600 * 1000)
    const iso = d.toISOString().slice(0, 10)
    const dow = d.getUTCDay() // 0 = Sunday
    cells.push({
      col: Math.floor(i / 7),
      row: dow,
      date: iso,
      count: counts.get(iso) ?? 0,
      isFuture: d > lastDay,
    })
  }

  const gridWidth = WEEKS * (CELL_PX + GAP_PX)

  return (
    <div className="bg-app-surface border border-app-border rounded-2xl p-3 overflow-x-auto">
      <div
        className="grid grid-flow-col"
        style={{
          width: gridWidth,
          gridTemplateRows: `repeat(7, ${CELL_PX}px)`,
          gap: GAP_PX,
        }}
      >
        {cells.map((cell) => (
          <div
            key={cell.date}
            title={`${cell.date}: ${cell.count} карточек`}
            className={`rounded-[2px] ${heatmapColor(cell.count, cell.isFuture)}`}
            style={{ width: CELL_PX, height: CELL_PX }}
          />
        ))}
      </div>
      <div className="flex justify-between items-center mt-2 px-1 text-[10px] text-app-hint">
        <span>меньше</span>
        <div className="flex gap-1">
          <div className={`w-3 h-3 rounded-[2px] ${heatmapColor(0, false)}`} />
          <div className={`w-3 h-3 rounded-[2px] ${heatmapColor(1, false)}`} />
          <div className={`w-3 h-3 rounded-[2px] ${heatmapColor(8, false)}`} />
          <div className={`w-3 h-3 rounded-[2px] ${heatmapColor(20, false)}`} />
          <div className={`w-3 h-3 rounded-[2px] ${heatmapColor(40, false)}`} />
        </div>
        <span>больше</span>
      </div>
    </div>
  )
}

function heatmapColor(count: number, isFuture: boolean): string {
  if (isFuture) return 'bg-transparent'
  if (count === 0) return 'bg-app-border'
  if (count <= 5) return 'bg-app-primary/20'
  if (count <= 15) return 'bg-app-primary/40'
  if (count <= 30) return 'bg-app-primary/70'
  return 'bg-app-primary'
}
