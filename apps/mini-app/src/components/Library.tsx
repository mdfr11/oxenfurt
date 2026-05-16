import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { backButton, hapticFeedback } from '@telegram-apps/sdk-react'
import { Spinner } from '@telegram-apps/telegram-ui'
import { Archive, ArrowLeft, BookOpen, Search, X } from 'lucide-react'
import type {
  CardListDto,
  CardListResponse,
  TheoryPayload,
  VocabPayload,
} from '@oxenfurt/shared'
import { fetchWithAuth } from '../lib/api'
import { Markdown } from './Markdown'

interface LibraryProps {
  onExit: () => void
}

type TypeFilter = 'all' | 'vocab' | 'theory'
type StatusFilter = 'active' | 'archived'

function safeHaptic<T extends keyof typeof hapticFeedback>(
  method: T,
  ...args: Parameters<typeof hapticFeedback[T]>
): void {
  try {
    (hapticFeedback[method] as (...a: typeof args) => void)(...args)
  } catch {
    // SDK not mounted — ignore
  }
}

interface SourceEntry {
  source: string | null
  total: number
  vocab_count: number
  theory_count: number
  latest: string
}

export function Library({ onExit }: LibraryProps) {
  const queryClient = useQueryClient()
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active')
  const [search, setSearch] = useState('')
  const [openCard, setOpenCard] = useState<CardListDto | null>(null)
  // Source filter — `null` = no filter, '__none__' = cards without source,
  // any other string = exact source match. Decoupled from the search input
  // so the user can combine "all from lesson-X" + "contains 'pragmatic'".
  const [sourceFilter, setSourceFilter] = useState<string | null>(null)
  const [isSourcePickerOpen, setIsSourcePickerOpen] = useState(false)

  // Debounce search input — wait 250ms after last keystroke before issuing
  // the request, so a 6-letter query doesn't fire 6 round-trips.
  const [debouncedSearch, setDebouncedSearch] = useState(search)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250)
    return () => clearTimeout(t)
  }, [search])

  // BackButton — exit to Home.
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

  const queryParams = useMemo(() => {
    const params = new URLSearchParams()
    params.set('status', statusFilter)
    if (typeFilter !== 'all') params.set('type', typeFilter)
    if (debouncedSearch.trim()) params.set('q', debouncedSearch.trim())
    if (sourceFilter !== null) params.set('source', sourceFilter)
    params.set('limit', '100')
    return params.toString()
  }, [statusFilter, typeFilter, debouncedSearch, sourceFilter])

  const { data: sourcesData } = useQuery({
    queryKey: ['cards', 'sources', statusFilter],
    queryFn: async () => {
      const res = await fetchWithAuth(`/cards/sources?status=${statusFilter}`)
      if (!res.ok) throw new Error('Failed to load sources')
      return (await res.json()) as { sources: SourceEntry[] }
    },
  })

  const { data, isLoading, error } = useQuery({
    queryKey: ['cards', 'list', queryParams],
    queryFn: async () => {
      const res = await fetchWithAuth(`/cards?${queryParams}`)
      if (!res.ok) throw new Error('Failed to load library')
      return (await res.json()) as CardListResponse
    },
  })

  const archive = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetchWithAuth(`/cards/${id}/archive`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to archive')
      return res.json()
    },
    onSuccess: () => {
      safeHaptic('notificationOccurred', 'success')
      void queryClient.invalidateQueries({ queryKey: ['cards', 'list'] })
      void queryClient.invalidateQueries({ queryKey: ['cards', 'due'] })
      setOpenCard(null)
    },
  })

  const cards = data?.cards ?? []
  const total = data?.total ?? 0

  return (
    <div
      className="flex-1 flex flex-col h-full w-full min-h-0 bg-app-bg text-app-text"
      style={{
        paddingTop: `calc(0.75rem + var(--tg-safe-area-inset-top, 0px))`,
        paddingBottom: `calc(0.5rem + var(--tg-safe-area-inset-bottom, 0px))`,
      }}
    >
      {/* Header */}
      <div className="px-4 pb-3 flex items-center gap-3">
        <button
          onClick={onExit}
          className="w-10 h-10 flex items-center justify-center rounded-full bg-app-surface border border-app-border active:scale-90 transition-transform"
          aria-label="Назад"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-bold leading-none">Карточки</h1>
          <p className="text-xs text-app-hint mt-1">{total} {pluralize(total)}</p>
        </div>
      </div>

      {/* Search */}
      <div className="px-4 pb-3">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-app-hint" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по слову или переводу"
            className="w-full pl-10 pr-3 py-3 rounded-2xl bg-app-surface border border-app-border text-sm placeholder:text-app-hint focus:outline-none focus:border-app-primary"
          />
        </div>
      </div>

      {/* Filter chips */}
      <div className="px-4 pb-3 flex gap-2 overflow-x-auto scrollbar-none">
        <FilterChip active={typeFilter === 'all'} onClick={() => setTypeFilter('all')}>
          Все
        </FilterChip>
        <FilterChip active={typeFilter === 'vocab'} onClick={() => setTypeFilter('vocab')}>
          Слова
        </FilterChip>
        <FilterChip active={typeFilter === 'theory'} onClick={() => setTypeFilter('theory')}>
          Теория
        </FilterChip>
        <div className="w-px bg-app-border self-stretch mx-1" />
        <FilterChip
          active={statusFilter === 'active'}
          onClick={() => setStatusFilter('active')}
        >
          Активные
        </FilterChip>
        <FilterChip
          active={statusFilter === 'archived'}
          onClick={() => setStatusFilter('archived')}
        >
          Архив
        </FilterChip>
        <div className="w-px bg-app-border self-stretch mx-1" />
        <button
          onClick={() => setIsSourcePickerOpen(true)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
            sourceFilter !== null
              ? 'bg-app-primary text-app-primary-text'
              : 'bg-app-surface border border-app-border text-app-text'
          }`}
        >
          <BookOpen size={12} />
          {sourceFilter === null
            ? 'По уроку'
            : sourceFilter === '__none__'
              ? 'Без источника'
              : sourceFilter}
        </button>
        {sourceFilter !== null && (
          <button
            onClick={() => setSourceFilter(null)}
            className="px-2 rounded-full bg-app-surface border border-app-border text-app-hint active:scale-95"
            aria-label="Сбросить фильтр уроков"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {isLoading ? (
          <div className="h-full flex items-center justify-center">
            <Spinner size="m" />
          </div>
        ) : error ? (
          <div className="text-center text-app-hint py-12 text-sm">
            Не удалось загрузить
          </div>
        ) : cards.length === 0 ? (
          <div className="text-center text-app-hint py-12 text-sm">
            Ничего не найдено
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {cards.map((card) => (
              <li key={card.id}>
                <CardListItem card={card} onOpen={() => setOpenCard(card)} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Detail sheet */}
      {openCard && (
        <CardDetailSheet
          card={openCard}
          onClose={() => setOpenCard(null)}
          onArchive={() => archive.mutate(openCard.id)}
          archiving={archive.isPending}
          onJumpToSource={(src) => {
            setSourceFilter(src ?? '__none__')
            setOpenCard(null)
          }}
        />
      )}

      {/* Source picker */}
      {isSourcePickerOpen && (
        <SourcePickerSheet
          sources={sourcesData?.sources ?? []}
          current={sourceFilter}
          onPick={(s) => {
            setSourceFilter(s)
            setIsSourcePickerOpen(false)
          }}
          onClose={() => setIsSourcePickerOpen(false)}
        />
      )}
    </div>
  )
}

function SourcePickerSheet({
  sources,
  current,
  onPick,
  onClose,
}: {
  sources: SourceEntry[]
  current: string | null
  onPick: (source: string | null) => void
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-end"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full bg-app-bg rounded-t-3xl max-h-[75vh] overflow-y-auto"
        style={{ paddingBottom: `calc(1.5rem + var(--tg-safe-area-inset-bottom, 0px))` }}
      >
        <div className="sticky top-0 bg-app-bg flex justify-center py-2">
          <div className="w-10 h-1 rounded-full bg-app-border" />
        </div>
        <div className="px-6 pb-4 flex flex-col gap-2">
          <h2 className="text-lg font-bold mb-2">Фильтр по уроку</h2>
          <button
            onClick={() => onPick(null)}
            className={`text-left px-4 py-3 rounded-xl border ${
              current === null ? 'bg-app-primary/10 border-app-primary text-app-primary' : 'bg-app-surface border-app-border text-app-text'
            } active:scale-[0.98] transition-transform`}
          >
            <div className="font-semibold">Все карточки</div>
            <div className="text-xs text-app-hint mt-0.5">Без ограничения по уроку</div>
          </button>
          {sources.length === 0 ? (
            <p className="text-app-hint text-sm text-center py-6">
              Пока нет уроков
            </p>
          ) : (
            sources.map((s) => {
              const key = s.source ?? '__none__'
              const label = s.source ?? 'Без источника'
              const isActive = current === key
              return (
                <button
                  key={key}
                  onClick={() => onPick(key)}
                  className={`text-left px-4 py-3 rounded-xl border ${
                    isActive ? 'bg-app-primary/10 border-app-primary text-app-primary' : 'bg-app-surface border-app-border text-app-text'
                  } active:scale-[0.98] transition-transform`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-semibold truncate">{label}</div>
                    <span className="text-[10px] uppercase tracking-widest text-app-hint font-bold shrink-0">
                      {s.total}
                    </span>
                  </div>
                  <div className="text-xs text-app-hint mt-0.5">
                    {s.vocab_count > 0 && <span>✏️ {s.vocab_count}</span>}
                    {s.vocab_count > 0 && s.theory_count > 0 && <span> · </span>}
                    {s.theory_count > 0 && <span>📖 {s.theory_count}</span>}
                  </div>
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

function CardListItem({ card, onOpen }: { card: CardListDto; onOpen: () => void }) {
  const title = card.type === 'vocab'
    ? (card.payload as VocabPayload).term
    : (card.payload as TheoryPayload).question
  const subtitle = card.type === 'vocab'
    ? (card.payload as VocabPayload).translation
    : (card.payload as TheoryPayload).answer.slice(0, 80)

  return (
    <button
      onClick={onOpen}
      className="w-full text-left p-4 rounded-2xl bg-app-surface border border-app-border active:scale-[0.98] transition-transform"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate">{title}</div>
          <div className="text-xs text-app-hint truncate mt-0.5">{subtitle}</div>
        </div>
        <span className={`text-[9px] uppercase tracking-wider font-bold shrink-0 ${
          card.type === 'theory' ? 'text-app-primary' : 'text-app-hint'
        }`}>
          {card.type === 'theory' ? '📖' : '✏️'}
        </span>
      </div>
      {card.reps > 0 && (
        <div className="text-[10px] text-app-hint mt-2 opacity-70">
          Повторений: {card.reps} · Ошибок: {card.lapses}
        </div>
      )}
    </button>
  )
}

function CardDetailSheet({
  card,
  onClose,
  onArchive,
  archiving,
  onJumpToSource,
}: {
  card: CardListDto
  onClose: () => void
  onArchive: () => void
  archiving: boolean
  onJumpToSource: (source: string | null) => void
}) {
  const isVocab = card.type === 'vocab'
  const vocab = isVocab ? (card.payload as VocabPayload) : null
  const theory = !isVocab ? (card.payload as TheoryPayload) : null

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-end"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full bg-app-bg rounded-t-3xl max-h-[85vh] overflow-y-auto"
        style={{ paddingBottom: `calc(1.5rem + var(--tg-safe-area-inset-bottom, 0px))` }}
      >
        <div className="sticky top-0 bg-app-bg flex justify-center py-2">
          <div className="w-10 h-1 rounded-full bg-app-border" />
        </div>
        <div className="px-6 pb-4 flex flex-col gap-5">
          {vocab && (
            <>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold mb-1">Слово</div>
                <h2 className="text-2xl font-bold">{vocab.term}</h2>
                <p className="text-sm text-app-hint mt-1">{vocab.translation}</p>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold mb-1">Из контекста</div>
                <p className="text-sm leading-relaxed">«{vocab.context_sentence}»</p>
              </div>
            </>
          )}
          {theory && (
            <>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold mb-1">Вопрос</div>
                <Markdown className="text-lg font-bold leading-snug">
                  {theory.question}
                </Markdown>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold mb-1">Ответ</div>
                <Markdown className="text-sm leading-relaxed">{theory.answer}</Markdown>
              </div>
              {card.source_quote && (
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold mb-1">Из урока</div>
                  <Markdown className="text-xs italic text-app-hint leading-relaxed" inline>
                    {`«${card.source_quote}»`}
                  </Markdown>
                </div>
              )}
            </>
          )}

          <div className="border-t border-app-border pt-4 text-[11px] text-app-hint space-y-1">
            <div>Повторений: <span className="font-semibold text-app-text">{card.reps}</span></div>
            <div>Ошибок: <span className="font-semibold text-app-text">{card.lapses}</span></div>
            <div>Следующее повторение: <span className="font-semibold text-app-text">{formatDue(card.due)}</span></div>
            {card.source && (
              <div>
                Источник:{' '}
                <button
                  onClick={() => onJumpToSource(card.source)}
                  className="font-semibold text-app-primary underline underline-offset-2 active:opacity-70"
                >
                  {card.source}
                </button>
              </div>
            )}
          </div>

          {card.status === 'active' && (
            <button
              onClick={onArchive}
              disabled={archiving}
              className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl border border-rose-500/30 text-rose-500 font-semibold active:scale-95 transition-transform disabled:opacity-50"
            >
              <Archive size={18} />
              {archiving ? 'Архивирую…' : 'В архив'}
            </button>
          )}
          {card.status === 'archived' && (
            <div className="text-center text-app-hint text-sm py-2">
              Карточка в архиве — не показывается в сессиях
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
        active
          ? 'bg-app-primary text-app-primary-text'
          : 'bg-app-surface border border-app-border text-app-text'
      }`}
    >
      {children}
    </button>
  )
}

function pluralize(n: number): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 14) return 'карточек'
  const mod10 = n % 10
  if (mod10 === 1) return 'карточка'
  if (mod10 >= 2 && mod10 <= 4) return 'карточки'
  return 'карточек'
}

function formatDue(iso: string): string {
  const due = new Date(iso)
  const now = new Date()
  const diffMs = due.getTime() - now.getTime()
  if (diffMs <= 0) return 'сейчас'
  const days = Math.round(diffMs / (1000 * 60 * 60 * 24))
  if (days === 0) {
    const hours = Math.round(diffMs / (1000 * 60 * 60))
    return hours <= 0 ? `${Math.round(diffMs / 60000)}м` : `через ${hours}ч`
  }
  if (days === 1) return 'завтра'
  if (days < 30) return `через ${days} ${pluralizeDays(days)}`
  const months = Math.round(days / 30)
  return `через ${months}мес`
}

function pluralizeDays(n: number): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 14) return 'дней'
  const mod10 = n % 10
  if (mod10 === 1) return 'день'
  if (mod10 >= 2 && mod10 <= 4) return 'дня'
  return 'дней'
}
