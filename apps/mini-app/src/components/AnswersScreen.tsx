import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { backButton } from '@telegram-apps/sdk-react'
import { ArrowLeft, MessageCircle, Trash2 } from 'lucide-react'
import { fetchWithAuth } from '../lib/api'
import { Markdown } from './Markdown'
import { useT } from '../lib/i18n/useT'
import type { TKey } from '../lib/i18n'

function plurAnswers(n: number, t: ReturnType<typeof useT>): string {
  const mod100 = n % 100
  let key: TKey = 'answers.count_many'
  if (!(mod100 >= 11 && mod100 <= 14)) {
    const mod10 = n % 10
    if (mod10 === 1) key = 'answers.count_one'
    else if (mod10 >= 2 && mod10 <= 4) key = 'answers.count_few'
  }
  return t(key, { n })
}

interface Props {
  onExit: () => void
}

interface QuestionDto {
  id: string
  card_id: string
  question: string
  status: 'pending' | 'answered' | 'discarded'
  response: string | null
  created_at: string
  answered_at: string | null
  seen_at: string | null
}

// Read view for answers from Hermes. Loads everything still unread, lets
// the user mark each as seen (or discard). No editor — answers are
// generated; if the user wants to ask follow-ups, they go back to the
// card itself.
export function AnswersScreen({ onExit }: Props) {
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
    queryKey: ['questions', 'unread'],
    queryFn: async () => {
      const res = await fetchWithAuth('/questions/unread')
      if (!res.ok) throw new Error('Failed to load')
      return (await res.json()) as { unread: QuestionDto[] }
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
          <p className="text-xs text-app-hint mt-1">{items.length} {plurAnswers(items.length, t)}</p>
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
