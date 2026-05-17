import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { backButton } from '@telegram-apps/sdk-react'
import { haptic } from '../lib/telegram'
import { Spinner } from '@telegram-apps/telegram-ui'
import { Archive, ArrowLeft, BookOpen, Search, X, Quote, Type, HelpCircle, Flame } from 'lucide-react'
import type {
  CardListDto,
  CardListResponse,
  PhrasePayload,
  TheoryPayload,
  VocabPayload,
} from '@oxenfurt/shared'
import { fetchWithAuth } from '../lib/api'
import { Markdown } from './Markdown'
import { useT } from '../lib/i18n/useT'
import { plurKey } from '../lib/i18n/plural'
import { QuestionSheet } from './QuestionSheet'

interface LibraryProps {
  onExit: () => void
  /** When set, Library opens this card's EditCardSheet as soon as the
   *  list query lands. Deep-link from AnswersScreen "jump to card". */
  autoOpenCardId?: string | null
  /** Called once the deep-link has been resolved (whether the card was
   *  found or not), so the parent can clear its pending state. */
  onAutoOpenConsumed?: () => void
}

type TypeFilter = 'all' | 'vocab' | 'theory' | 'phrase'
type StatusFilter = 'active' | 'archived'

interface SourceEntry {
  source: string | null
  total: number
  vocab_count: number
  phrase_count: number
  theory_count: number
  latest: string
}

export function Library({ onExit, autoOpenCardId, onAutoOpenConsumed }: LibraryProps) {
  const t = useT()
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
      haptic('notificationOccurred', 'success')
      void queryClient.invalidateQueries({ queryKey: ['cards', 'list'] })
      void queryClient.invalidateQueries({ queryKey: ['cards', 'due'] })
      setOpenCard(null)
    },
  })

  // Memoised so the deep-link effect's deps array stays stable across
  // renders that didn't actually change the card list (otherwise the
  // `data?.cards ?? []` fallback creates a fresh array each time).
  const cards = useMemo(() => data?.cards ?? [], [data?.cards])
  const total = data?.total ?? 0

  // Deep-link from AnswersScreen: open the requested card as soon as
  // it shows up in the loaded list. We reset filters once (so a card
  // hidden by an active type/source filter still resolves) and try
  // both active and archived statuses. The `consumed` flag prevents
  // re-opening if the user closes the sheet and the parent prop
  // hasn't been cleared yet.
  // Deep-link resolution requires setState inside an effect: the
  // result depends on async data (the /cards query) and on widened
  // filters that also need state writes. eslint's set-state-in-effect
  // rule is conservative — this is one of the legitimate uses
  // (resolving asynchronously-discovered state). Disable per-line
  // with a comment explaining why.
  const [autoOpenConsumed, setAutoOpenConsumed] = useState(false)
  useEffect(() => {
    if (autoOpenCardId === null || autoOpenCardId === undefined) return
    if (autoOpenConsumed) return
    if (isLoading) return
    const found = cards.find((c) => c.id === autoOpenCardId)
    if (found) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpenCard(found)
      setAutoOpenConsumed(true)
      onAutoOpenConsumed?.()
      return
    }
    // Not in current filter view. Reset filters once to widen the net.
    // If we've already widened (filters are at defaults) and the card
    // still isn't here, try the archived bucket.
    const filtersAtDefault =
      typeFilter === 'all' && search === '' && sourceFilter === null
    if (!filtersAtDefault) {
      setTypeFilter('all')
      setSearch('')
      setSourceFilter(null)
    } else if (statusFilter === 'active') {
      setStatusFilter('archived')
    } else {
      // Card genuinely not found anywhere — give up.
      setAutoOpenConsumed(true)
      onAutoOpenConsumed?.()
    }
  }, [autoOpenCardId, autoOpenConsumed, isLoading, cards, typeFilter, search, sourceFilter, statusFilter, onAutoOpenConsumed])

  // Reset the consumed flag whenever a new deep-link target arrives so
  // back-to-back jumps from AnswersScreen work. Same setState-in-effect
  // exception — the trigger (parent prop change) is asynchronous from
  // this component's perspective.
  useEffect(() => {
    if (autoOpenCardId !== null && autoOpenCardId !== undefined) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAutoOpenConsumed(false)
    }
  }, [autoOpenCardId])

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
          aria-label={t('common.back')}
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-bold leading-none">{t('library.title')}</h1>
          <p className="text-xs text-app-hint mt-1">{t(plurKey(total, 'library.count_one', 'library.count_few', 'library.count_many'), { n: total })}</p>
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
            placeholder={t('library.search_placeholder')}
            className="w-full pl-10 pr-3 py-3 rounded-2xl bg-app-surface border border-app-border text-sm placeholder:text-app-hint focus:outline-none focus:border-app-primary"
          />
        </div>
      </div>

      {/* Filter chips */}
      <div className="px-4 pb-3 flex gap-2 overflow-x-auto scrollbar-none">
        <FilterChip active={typeFilter === 'all'} onClick={() => setTypeFilter('all')}>
          {t('library.filter_all')}
        </FilterChip>
        <FilterChip active={typeFilter === 'vocab'} onClick={() => setTypeFilter('vocab')}>
          {t('library.filter_vocab')}
        </FilterChip>
        <FilterChip active={typeFilter === 'phrase'} onClick={() => setTypeFilter('phrase')}>
          {t('library.filter_phrase')}
        </FilterChip>
        <FilterChip active={typeFilter === 'theory'} onClick={() => setTypeFilter('theory')}>
          {t('library.filter_theory')}
        </FilterChip>
        <div className="w-px bg-app-border self-stretch mx-1" />
        <FilterChip
          active={statusFilter === 'active'}
          onClick={() => setStatusFilter('active')}
        >
          {t('library.filter_active')}
        </FilterChip>
        <FilterChip
          active={statusFilter === 'archived'}
          onClick={() => setStatusFilter('archived')}
        >
          {t('library.filter_archived')}
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
            ? t('library.filter_source_default')
            : sourceFilter === '__none__'
              ? t('library.filter_source_none')
              : sourceFilter}
        </button>
        {sourceFilter !== null && (
          <button
            onClick={() => setSourceFilter(null)}
            className="px-2 rounded-full bg-app-surface border border-app-border text-app-hint active:scale-95"
            aria-label={t('library.aria_clear_source')}
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
            {t('library.empty_failed')}
          </div>
        ) : cards.length === 0 ? (
          <div className="text-center text-app-hint py-12 text-sm">
            {t('library.empty_not_found')}
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
  const t = useT()
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
          <h2 className="text-lg font-bold mb-2">{t('library.source_picker_title')}</h2>
          <button
            onClick={() => onPick(null)}
            className={`text-left px-4 py-3 rounded-xl border ${
              current === null ? 'bg-app-primary/10 border-app-primary text-app-primary' : 'bg-app-surface border-app-border text-app-text'
            } active:scale-[0.98] transition-transform`}
          >
            <div className="font-semibold">{t('library.source_picker_all')}</div>
            <div className="text-xs text-app-hint mt-0.5">{t('library.source_picker_all_hint')}</div>
          </button>
          {sources.length === 0 ? (
            <p className="text-app-hint text-sm text-center py-6">
              {t('library.source_picker_empty')}
            </p>
          ) : (
            sources.map((s) => {
              const key = s.source ?? '__none__'
              const label = s.source ?? t('library.no_source_bucket')
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
                  <div className="text-xs text-app-hint mt-0.5 flex items-center gap-2">
                    {s.vocab_count > 0 && <span className="flex items-center gap-1"><Type size={10} /> {s.vocab_count}</span>}
                    {s.phrase_count > 0 && <span className="flex items-center gap-1"><Quote size={10} /> {s.phrase_count}</span>}
                    {s.theory_count > 0 && <span className="flex items-center gap-1"><BookOpen size={10} /> {s.theory_count}</span>}
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
  const t = useT()
  const title =
    card.type === 'vocab'
      ? (card.payload as VocabPayload).term
      : card.type === 'phrase'
        ? (card.payload as PhrasePayload).phrase
        : (card.payload as TheoryPayload).question
  const subtitle =
    card.type === 'vocab'
      ? (card.payload as VocabPayload).translation
      : card.type === 'phrase'
        ? (card.payload as PhrasePayload).translation
        : (card.payload as TheoryPayload).answer.slice(0, 80)

  const Icon = card.type === 'theory' ? BookOpen : card.type === 'phrase' ? Quote : Type
  const iconClass = card.type === 'theory' ? 'text-app-primary' : 'text-app-hint'

  return (
    <button
      onClick={onOpen}
      className="w-full text-left p-4 rounded-2xl bg-app-surface border border-app-border active:scale-[0.98] transition-transform"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold flex items-center gap-2">
            <span className="truncate">{title}</span>
            {card.has_questions && (
              <span className="shrink-0 flex items-center justify-center w-4 h-4 rounded bg-app-primary/10 text-app-primary border border-app-primary/20">
                <HelpCircle size={10} strokeWidth={2.5} />
              </span>
            )}
          </div>
          <div className="text-xs text-app-hint truncate mt-0.5">{subtitle}</div>
        </div>
        <span className={`shrink-0 mt-0.5 ${iconClass}`}>
          <Icon size={14} strokeWidth={2.5} />
        </span>
      </div>
      {card.reps > 0 && (
        <div className="flex items-center gap-2 text-[10px] text-app-hint mt-2 opacity-70">
          <span>{t('library.detail_reviews')}: {card.reps}</span>
          <span>·</span>
          <span className={card.lapses >= 4 ? 'text-rose-500 font-bold opacity-100 flex items-center gap-0.5' : ''}>
            {card.lapses >= 4 && <Flame size={10} />}
            {t('library.detail_lapses')}: {card.lapses}
          </span>
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
  const t = useT()
  const [isQuestionOpen, setIsQuestionOpen] = useState(false)
  const vocab = card.type === 'vocab' ? (card.payload as VocabPayload) : null
  const phrase = card.type === 'phrase' ? (card.payload as PhrasePayload) : null
  const theory = card.type === 'theory' ? (card.payload as TheoryPayload) : null

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
                <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold mb-1">{t('library.detail_word')}</div>
                <h2 className="text-2xl font-bold">{vocab.term}</h2>
                <p className="text-sm text-app-hint mt-1">{vocab.translation}</p>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold mb-1">{t('library.detail_context')}</div>
                <p className="text-sm leading-relaxed">«{vocab.context_sentence}»</p>
              </div>
            </>
          )}
          {phrase && (
            <>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold mb-1">{t('library.detail_phrase')}</div>
                <h2 className="text-xl font-bold leading-snug">{phrase.phrase}</h2>
                <p className="text-sm text-app-hint mt-1">{phrase.translation}</p>
                {phrase.pattern && (
                  <p className="text-xs text-app-hint mt-1.5 font-mono">{phrase.pattern}</p>
                )}
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold mb-1">{t('library.detail_context')}</div>
                <p className="text-sm leading-relaxed">«{phrase.context_sentence}»</p>
              </div>
            </>
          )}
          {theory && (
            <>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold mb-1">{t('library.detail_question')}</div>
                <Markdown className="text-lg font-bold leading-snug">
                  {theory.question}
                </Markdown>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold mb-1">{t('library.detail_answer')}</div>
                <Markdown className="text-sm leading-relaxed">{theory.answer}</Markdown>
              </div>
              {card.source_quote && (
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold mb-1">{t('library.detail_from_lesson')}</div>
                  <Markdown className="text-xs italic text-app-hint leading-relaxed" inline>
                    {`«${card.source_quote}»`}
                  </Markdown>
                </div>
              )}
            </>
          )}

          <div className="border-t border-app-border pt-4 text-[11px] text-app-hint space-y-1">
            <div>{t('library.detail_reviews')}: <span className="font-semibold text-app-text">{card.reps}</span></div>
            <div>{t('library.detail_lapses')}: <span className="font-semibold text-app-text">{card.lapses}</span></div>
            <div>{t('library.detail_next_review')}: <span className="font-semibold text-app-text">{formatDue(card.due, t)}</span></div>
            {card.source && (
              <div>
                {t('library.detail_source')}:{' '}
                <button
                  onClick={() => onJumpToSource(card.source)}
                  className="font-semibold text-app-primary underline underline-offset-2 active:opacity-70"
                >
                  {card.source}
                </button>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2 pt-2">
            <button
              onClick={() => setIsQuestionOpen(true)}
              className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl border border-app-primary/30 text-app-primary font-semibold active:scale-95 transition-transform"
            >
              <HelpCircle size={18} />
              {card.has_questions ? t('library.btn_questions_has_history') : t('library.btn_questions')}
            </button>

            {card.status === 'active' && (
              <button
                onClick={onArchive}
                disabled={archiving}
                className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl border border-rose-500/30 text-rose-500 font-semibold active:scale-95 transition-transform disabled:opacity-50"
              >
                <Archive size={18} />
                {archiving ? t('library.btn_archiving') : t('library.btn_archive')}
              </button>
            )}
            {card.status === 'archived' && (
              <div className="text-center text-app-hint text-sm py-2">
                {t('library.archived_notice')}
              </div>
            )}
          </div>
        </div>
      </div>
      <QuestionSheet
        isOpen={isQuestionOpen}
        onClose={() => setIsQuestionOpen(false)}
        cardId={card.id}
      />
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


function formatDue(iso: string, t: ReturnType<typeof useT>): string {
  const due = new Date(iso)
  const now = new Date()
  const diffMs = due.getTime() - now.getTime()
  if (diffMs <= 0) return t('date.now')
  const days = Math.round(diffMs / (1000 * 60 * 60 * 24))
  if (days === 0) {
    const hours = Math.round(diffMs / (1000 * 60 * 60))
    return hours <= 0
      ? t('date.in_minutes', { n: Math.round(diffMs / 60_000) })
      : t('date.in_hours', { n: hours })
  }
  if (days === 1) return t('date.tomorrow')
  if (days < 30) {
    return t(plurKey(days, 'date.in_days_one', 'date.in_days_few', 'date.in_days_many'), { n: days })
  }
  return t('date.in_months', { n: Math.round(days / 30) })
}

