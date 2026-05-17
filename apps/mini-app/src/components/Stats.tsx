import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { backButton } from '@telegram-apps/sdk-react'
import { Spinner } from '@telegram-apps/telegram-ui'
import { ArrowLeft, Scroll, Trophy, Key, FlaskConical, Feather } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import type { HeatmapCell, RecentSession, StatsResponse } from '@oxenfurt/shared'
import { fetchWithAuth } from '../lib/api'
import { useT } from '../lib/i18n/useT'
import { getLocale } from '../lib/i18n'
import { plurKey } from '../lib/i18n/plural'

interface StatsProps {
  onExit: () => void
}

export function Stats({ onExit }: StatsProps) {
  const t = useT()
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
        <h2 className="text-xl font-bold mb-2">{t('stats.empty_failed')}</h2>
        <p className="text-xs text-app-hint mb-6">{error instanceof Error ? error.message : 'unknown'}</p>
        <button onClick={onExit} className="text-app-link font-semibold">{t('common.back')}</button>
      </div>
    )
  }

  const todayAcc = accuracy(data.reviews.today)
  const weekAcc = accuracy(data.reviews.last_7d)
  const monthAcc = accuracy(data.reviews.last_30d)
  // Numeric accuracy for the relic-unlock check below. parseInt('—')
  // returned NaN before, which compared false against 90 by accident —
  // worked but fragile. Compute from the source counts directly.
  const monthAccNum =
    data.reviews.last_30d.count > 0
      ? Math.round((data.reviews.last_30d.correct / data.reviews.last_30d.count) * 100)
      : 0

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
          aria-label={t('common.back')}
        >
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-xl font-bold leading-none flex-1">{t('stats.title')}</h1>
      </div>

      <div className="px-4 flex flex-col gap-5">
        {/* Top numbers */}
        <div className="grid grid-cols-3 gap-2">
          <StatCard label={t('stats.today')} count={data.reviews.today.count} sub={todayAcc} />
          <StatCard label={t('stats.week')} count={data.reviews.last_7d.count} sub={weekAcc} />
          <StatCard label={t('stats.month')} count={data.reviews.last_30d.count} sub={monthAcc} />
        </div>

        {/* Forecast */}
        <div className="bg-app-surface border border-app-border rounded-2xl p-4 flex justify-around shadow-sm">
          <ForecastCell label={t('stats.forecast_due_now')} value={data.forecast.due_now} accent />
          <ForecastCell label={t('stats.forecast_next_24h')} value={data.forecast.due_next_24h} />
          <ForecastCell label={t('stats.forecast_active_total')} value={data.forecast.active_total} />
        </div>

        {/* Relics Section */}
        <div>
          <h2 className="text-[11px] uppercase tracking-widest text-app-hint font-bold mb-3 px-1">
            {t('stats.relics_heading')}
          </h2>
          <div className="grid grid-cols-5 gap-2 px-1">
             <RelicIcon
               icon={Scroll}
               label={t('stats.relic_scroll_label')}
               hint={t('stats.relic_scroll_hint')}
               unlocked={data.recent_sessions.length > 0}
             />
             <RelicIcon
               icon={Trophy}
               label={t('stats.relic_trophy_label')}
               hint={t('stats.relic_trophy_hint')}
               unlocked={data.learned_count >= 100}
             />
             <RelicIcon
               icon={Key}
               label={t('stats.relic_key_label')}
               hint={t('stats.relic_key_hint')}
               unlocked={data.heatmap.reduce((acc, c) => acc + c.count, 0) >= 500}
             />
             <RelicIcon
               icon={FlaskConical}
               label={t('stats.relic_flask_label')}
               hint={t('stats.relic_flask_hint')}
               unlocked={data.streak >= 7}
             />
             <RelicIcon
               icon={Feather}
               label={t('stats.relic_feather_label')}
               hint={t('stats.relic_feather_hint')}
               unlocked={monthAccNum >= 90}
             />
          </div>
        </div>

        {/* Heatmap */}
        <div>
          <h2 className="text-[11px] uppercase tracking-widest text-app-hint font-bold mb-2 px-1">
            {t('stats.heatmap_heading')}
          </h2>
          <Heatmap heatmap={data.heatmap} generatedAt={data.generated_at} />
        </div>

        {/* Recent sessions */}
        <div>
          <h2 className="text-[11px] uppercase tracking-widest text-app-hint font-bold mb-2 px-1">
            {t('stats.recent_heading')}
          </h2>
          {data.recent_sessions.length === 0 ? (
            <p className="text-xs text-app-hint px-1 italic">{t('stats.recent_empty')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
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
  const t = useT()
  return (
    <div className="bg-app-surface border border-app-border rounded-2xl p-3 flex flex-col shadow-sm">
      <div className="text-[9px] uppercase tracking-wider text-app-hint font-bold">{label}</div>
      <div className="text-2xl font-bold mt-0.5">{count}</div>
      <div className="text-[10px] text-app-hint mt-0.5">{t('stats.accuracy_label', { value: sub })}</div>
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

function RelicIcon({ icon: Icon, label, hint, unlocked }: { icon: React.ElementType; label: string; hint: string; unlocked: boolean }) {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <div className="flex flex-col items-center gap-1 relative">
      <motion.div 
        initial={false}
        animate={unlocked ? { scale: 1, filter: 'grayscale(0)' } : { scale: 0.95, filter: 'grayscale(1)' }}
        className={`w-12 h-12 rounded-2xl border flex items-center justify-center transition-all cursor-pointer ${
          unlocked 
            ? 'bg-app-primary/10 border-app-primary/30 text-app-primary shadow-sm' 
            : 'bg-app-surface border-app-border text-app-hint opacity-40'
        }`}
        onClick={() => setShowTooltip(true)}
      >
        <Icon size={20} strokeWidth={1.5} />
      </motion.div>
      
      <AnimatePresence>
        {showTooltip && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowTooltip(false)}
              className="fixed inset-0 z-[60]"
            />
            <motion.div
              initial={{ opacity: 0, y: 10, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.9 }}
              className="absolute -top-16 left-1/2 -translate-x-1/2 bg-zinc-900 text-white text-[10px] px-3 py-2 rounded-xl whitespace-nowrap z-[70] shadow-xl pointer-events-none flex flex-col items-center"
            >
              <div className="font-bold">{label}</div>
              <div className="opacity-70">{hint}</div>
              <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-zinc-900 rotate-45" />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function SessionRow({ session }: { session: RecentSession }) {
  const t = useT()
  const acc = session.cards_reviewed > 0
    ? Math.round((session.cards_correct / session.cards_reviewed) * 100)
    : 0
  return (
    <div className="bg-app-surface border border-app-border rounded-xl px-4 py-2.5 flex items-center justify-between shadow-sm">
      <div className="text-sm">
        <div className="font-semibold">{formatDate(session.finished_at, t)}</div>
        <div className="text-[11px] text-app-hint mt-0.5">{formatTime(session.finished_at)}</div>
      </div>
      <div className="text-right">
        <div className="text-sm font-semibold">{t(plurKey(session.cards_reviewed, 'stats.session_cards_one', 'stats.session_cards_few', 'stats.session_cards_many'), { n: session.cards_reviewed })}</div>
        <div className="text-[11px] text-app-hint mt-0.5">{t('stats.session_accuracy', { n: acc })}</div>
      </div>
    </div>
  )
}

function formatDate(iso: string, t: ReturnType<typeof useT>): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 24 * 3600 * 1000)
  if (sameDay(d, today)) return t('stats.date_today')
  if (sameDay(d, yesterday)) return t('stats.date_yesterday')
  // Use the current i18n locale's BCP-47 tag so the month renders natively.
  const localeTag = getLocale() === 'ru' ? 'ru-RU' : 'en-US'
  return d.toLocaleDateString(localeTag, { day: 'numeric', month: 'short' })
}

function formatTime(iso: string): string {
  const localeTag = getLocale() === 'ru' ? 'ru-RU' : 'en-US'
  return new Date(iso).toLocaleTimeString(localeTag, { hour: '2-digit', minute: '2-digit' })
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
  const t = useT()
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
    <div className="bg-app-surface border border-app-border rounded-2xl p-3 overflow-x-auto shadow-sm">
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
            title={`${cell.date}: ${cell.count}`}
            className={`rounded-[2px] ${heatmapColor(cell.count, cell.isFuture)}`}
            style={{ width: CELL_PX, height: CELL_PX }}
          />
        ))}
      </div>
      <div className="flex justify-between items-center mt-2 px-1 text-[10px] text-app-hint">
        <span>{t('stats.heatmap_less')}</span>
        <div className="flex gap-1">
          <div className={`w-3 h-3 rounded-[2px] ${heatmapColor(0, false)}`} />
          <div className={`w-3 h-3 rounded-[2px] ${heatmapColor(1, false)}`} />
          <div className={`w-3 h-3 rounded-[2px] ${heatmapColor(8, false)}`} />
          <div className={`w-3 h-3 rounded-[2px] ${heatmapColor(20, false)}`} />
          <div className={`w-3 h-3 rounded-[2px] ${heatmapColor(40, false)}`} />
        </div>
        <span>{t('stats.heatmap_more')}</span>
      </div>
    </div>
  )
}

function heatmapColor(count: number, isFuture: boolean): string {
  if (isFuture) return 'bg-transparent'
  if (count === 0) return 'bg-app-border/40 dark:bg-zinc-800/40'
  if (count <= 5) return 'bg-app-primary/20'
  if (count <= 15) return 'bg-app-primary/40'
  if (count <= 30) return 'bg-app-primary/70'
  return 'bg-app-primary'
}
