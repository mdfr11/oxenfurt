import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { backButton } from '@telegram-apps/sdk-react'
import { ArrowLeft, MessageCircle, Trash2, Quote, Type, BookOpen, ChevronRight } from 'lucide-react'
import { getScopeSlug } from '../lib/scope'
import { fetchWithAuth } from '../lib/api'
import { Markdown } from './Markdown'
import { useT } from '../lib/i18n/useT'
import { plurKey } from '../lib/i18n/plural'

interface Props {
  onExit: () => void
  /** Optional deep-link callback. When provided, each answer becomes a
   *  tappable affordance that jumps to the card in Library. */
  onJumpToCard?: (cardId: string) => void
}

interface UnreadQuestionDto {
  id: string
  card_id: string
  question: string
  status: 'pending' | 'answered' | 'discarded'
  response: string | null
  created_at: string
  answered_at: string | null
  seen_at: string | null
  card: {
    id: string
    type: 'vocab' | 'theory' | 'phrase'
    title: string
    source: string | null
  }
}

// Read view for answers from Hermes. Loads everything still unread, lets
// the user mark each as seen (or discard). No editor — answers are
// generated; if the user wants to ask follow-ups, they go back to the
// card itself.
export function AnswersScreen({ onExit, onJumpToCard }: Props) {
  const t = useT()
  const queryClient = useQueryClient()

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

  const { data, isLoading } = useQuery({
    queryKey: [getScopeSlug() ?? 'no-scope', 'questions', 'unread'],
    queryFn: async () => {
      const res = await fetchWithAuth('/questions/unread')
      if (!res.ok) throw new Error('Failed to load')
      return (await res.json()) as { unread: UnreadQuestionDto[] }
    },
  })

  const markSeen = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetchWithAuth(`/questions/${id}/seen`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to mark seen')
      return res.json()
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['questions'] })
    },
  })

  const discard = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetchWithAuth(`/questions/${id}/discard`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to discard')
      return res.json()
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['questions'] })
    },
  })

  const items = data?.unread ?? []

  return (
    <div
      className="flex-1 flex flex-col h-full w-full min-h-0 bg-app-bg text-app-text"
      style={{
        paddingTop: `calc(0.75rem + var(--tg-safe-area-inset-top, 0px))`,
        paddingBottom: `calc(0.5rem + var(--tg-safe-area-inset-bottom, 0px))`,
      }}
    >
      <div className="px-4 pb-3 flex items-center gap-3">
        <button
          onClick={onExit}
          className="w-10 h-10 flex items-center justify-center rounded-full bg-app-surface border border-app-border active:scale-90 transition-transform"
          aria-label={t('common.back')}
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-bold leading-none">{t('answers.title')}</h1>
          <p className="text-xs text-app-hint mt-1">{t(plurKey(items.length, 'answers.count_one', 'answers.count_few', 'answers.count_many'), { n: items.length })}</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {isLoading ? (
          <p className="text-center text-app-hint py-12 text-sm">{t('common.loading')}</p>
        ) : items.length === 0 ? (
          <div className="text-center text-app-hint py-12 text-sm">
            <MessageCircle size={32} className="mx-auto mb-3 opacity-40" />
            <p>{t('answers.empty_title')}</p>
            <p className="mt-2 text-[11px] opacity-70">
              {t('answers.empty_hint')}
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((q) => (
              <li
                key={q.id}
                className="p-4 rounded-2xl bg-app-surface border border-app-border"
              >
                {/* Card preview header — tap to jump to the card in
                    Library. When onJumpToCard isn't wired up (older host
                    or test harness) it degrades to a plain block, no
                    onClick. */}
                <button
                  type="button"
                  onClick={onJumpToCard ? () => onJumpToCard(q.card.id) : undefined}
                  disabled={!onJumpToCard}
                  className="w-full flex items-center gap-2 mb-3 pb-3 border-b border-app-border/60 text-left active:opacity-60 transition-opacity disabled:active:opacity-100"
                >
                  <div className="w-7 h-7 rounded-full bg-app-primary/10 text-app-primary flex items-center justify-center shrink-0">
                    {q.card.type === 'vocab' ? <Type size={13} />
                      : q.card.type === 'phrase' ? <Quote size={13} />
                      : <BookOpen size={13} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-app-text truncate">
                      {q.card.title || t('common.empty')}
                    </div>
                    {q.card.source !== null && q.card.source.length > 0 && (
                      <div className="text-[10px] text-app-hint truncate">{q.card.source}</div>
                    )}
                  </div>
                  {onJumpToCard && (
                    <ChevronRight size={14} className="text-app-hint shrink-0" />
                  )}
                </button>

                <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold mb-1">
                  {t('answers.field_question')}
                </div>
                <p className="text-sm text-app-text leading-snug whitespace-pre-wrap">
                  {q.question}
                </p>
                <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold mt-4 mb-1">
                  {t('answers.field_response')}
                </div>
                {q.response !== null ? (
                  <Markdown className="text-sm leading-relaxed text-app-text">
                    {q.response}
                  </Markdown>
                ) : (
                  <p className="text-sm text-app-hint italic">{t('answers.empty_response')}</p>
                )}
                <div className="flex gap-2 mt-4">
                  <button
                    onClick={() => markSeen.mutate(q.id)}
                    disabled={markSeen.isPending}
                    className="flex-1 py-2 rounded-xl bg-app-primary text-app-primary-text text-sm font-semibold active:scale-95 transition-transform disabled:opacity-50"
                  >
                    {t('answers.btn_mark_read')}
                  </button>
                  <button
                    onClick={() => discard.mutate(q.id)}
                    disabled={discard.isPending}
                    className="px-3 py-2 rounded-xl bg-app-bg border border-app-border text-app-hint text-sm active:scale-95 transition-transform"
                    aria-label={t('common.discard')}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
