import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { X, Send, Clock, CheckCircle2 } from 'lucide-react'
import { fetchWithAuth } from '../lib/api'
import { Markdown } from './Markdown'
import { useT } from '../lib/i18n/useT'
import { BottomSheet } from './BottomSheet'

interface Props {
  cardId: string | null
  isOpen: boolean
  onClose: () => void
}

interface CardQuestionDto {
  id: string
  card_id: string
  question: string
  status: 'pending' | 'answered' | 'discarded'
  response: string | null
  created_at: string
  answered_at: string | null
  seen_at: string | null
}

// Card-specific question sheet. The user types whatever is unclear; on
// submit it's persisted with status='pending' and Hermes will pick it up
// async. No spinner waiting on an LLM in-session — the user can return to
// it later via the Home badge.
//
// History section below the form lists every question the user has
// previously asked about this card (any status). Replaces the previously
// missing "where did my old question go?" answer — pending ones show a
// spinner-like indicator, answered ones show the Markdown response
// inline so the learner doesn't need to backtrack to /answers.
export function QuestionSheet({ cardId, isOpen, onClose }: Props) {
  const t = useT()
  const queryClient = useQueryClient()
  const [text, setText] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')

  const { data: historyData } = useQuery({
    enabled: isOpen && cardId !== null,
    queryKey: ['questions', 'card', cardId],
    queryFn: async () => {
      const res = await fetchWithAuth(`/questions/card/${cardId}`)
      if (!res.ok) throw new Error('Failed to load')
      return (await res.json()) as { questions: CardQuestionDto[] }
    },
  })
  const history = (historyData?.questions ?? []).filter((q) => q.status !== 'discarded')

  const handleSubmit = async () => {
    if (!cardId || text.trim().length === 0 || state === 'sending') return
    setState('sending')
    try {
      const res = await fetchWithAuth(`/questions/cards/${cardId}`, {
        method: 'POST',
        body: JSON.stringify({ question: text.trim() }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setState('sent')
      setText('')
      // Refresh history so the new question shows up immediately.
      void queryClient.invalidateQueries({ queryKey: ['questions', 'card', cardId] })
      void queryClient.invalidateQueries({ queryKey: ['questions', 'count'] })
      setTimeout(() => {
        setState('idle')
      }, 1200)
    } catch {
      setState('error')
    }
  }

  return (
    <BottomSheet isOpen={isOpen && cardId !== null} onClose={onClose}>
      <div className="flex justify-between items-start mb-3 text-app-text">
        <div>
          <h2 className="text-lg font-bold leading-tight">{t('question.title')}</h2>
          <p className="text-[11px] text-app-hint mt-0.5">{t('question.subtitle')}</p>
        </div>
        <button
          onClick={onClose}
          className="p-2 -mr-2 text-app-hint active:scale-95 transition-transform"
          aria-label={t('common.close')}
        >
          <X size={20} />
        </button>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        autoFocus
        placeholder={t('question.placeholder')}
        className="w-full shrink-0 bg-app-surface text-app-text border border-app-border rounded-xl py-3 px-4 focus:outline-none focus:border-app-primary resize-none text-sm"
        disabled={state === 'sending' || state === 'sent'}
      />

      <button
        onClick={handleSubmit}
        disabled={text.trim().length === 0 || state === 'sending' || state === 'sent'}
        className="mt-3 flex items-center justify-center gap-2 py-3 rounded-2xl bg-app-primary text-app-primary-text font-semibold active:scale-95 transition-transform disabled:opacity-50"
      >
        <Send size={16} />
        {state === 'sending' ? t('question.btn_sending') : state === 'sent' ? t('question.btn_sent') : t('question.btn_send')}
      </button>

      {state === 'error' && (
        <p className="text-xs text-rose-500 mt-2 text-center">{t('question.error_send')}</p>
      )}

      {/* History — past questions about this same card. Pending ones get
          a clock icon, answered ones show the response inline. */}
      {history.length > 0 && (
        <section className="mt-6 pt-5 border-t border-app-border/60">
          <h3 className="text-[10px] uppercase tracking-widest text-app-hint font-bold mb-3">
            {t('question.history_heading')}
          </h3>
          <ul className="flex flex-col gap-3">
            {history.map((q) => (
              <li
                key={q.id}
                className="p-3 rounded-xl bg-app-surface border border-app-border"
              >
                <div className="flex items-start gap-2">
                  <div className="mt-0.5 shrink-0">
                    {q.status === 'answered' ? (
                      <CheckCircle2 size={14} className="text-emerald-500" />
                    ) : (
                      <Clock size={14} className="text-app-hint" />
                    )}
                  </div>
                  <p className="text-sm text-app-text leading-snug whitespace-pre-wrap flex-1">
                    {q.question}
                  </p>
                </div>
                {q.status === 'answered' && q.response !== null && (
                  <div className="mt-2 pl-6">
                    <Markdown className="text-[13px] leading-relaxed text-app-hint">
                      {q.response}
                    </Markdown>
                  </div>
                )}
                {q.status === 'pending' && (
                  <p className="mt-1 pl-6 text-[11px] text-app-hint italic">
                    {t('question.status_pending')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div style={{ height: 'calc(0.5rem + var(--tg-safe-area-inset-bottom, 0px))' }} />
    </BottomSheet>
  )
}
