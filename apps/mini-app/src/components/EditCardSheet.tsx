import { useState } from 'react'
import { X, Save } from 'lucide-react'
import type { DueCardDto, VocabPayload, TheoryPayload, PhrasePayload } from '@oxenfurt/shared'
import { fetchWithAuth } from '../lib/api'
import { useT } from '../lib/i18n/useT'
import { BottomSheet } from './BottomSheet'

interface Props {
  card: DueCardDto | null
  isOpen: boolean
  onClose: () => void
  onSaved: (updated: DueCardDto) => void
}

// Edit-on-back sheet. Vocab cards expose term / translation / context;
// theory cards expose question / answer. FSRS state, source, status all
// stay untouched — purely a payload edit. Term offsets for vocab are
// recomputed server-side from the new term + sentence.
export function EditCardSheet({ card, isOpen, onClose, onSaved }: Props) {
  const t = useT()
  const [term, setTerm] = useState('')
  const [translation, setTranslation] = useState('')
  const [contextSentence, setContextSentence] = useState('')
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [phraseText, setPhraseText] = useState('')
  const [pattern, setPattern] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Track the current card ID to reset state when it changes
  const [lastCardId, setLastCardId] = useState<string | null>(null)

  if (card && card.id !== lastCardId) {
    setLastCardId(card.id)
    setError(null)
    if (card.type === 'vocab') {
      const p = card.payload as VocabPayload
      setTerm(p.term)
      setTranslation(p.translation)
      setContextSentence(p.context_sentence)
      setQuestion('')
      setAnswer('')
      setPhraseText('')
      setPattern('')
    } else if (card.type === 'phrase') {
      const p = card.payload as PhrasePayload
      setPhraseText(p.phrase)
      setTranslation(p.translation)
      setContextSentence(p.context_sentence)
      setPattern(p.pattern ?? '')
      setTerm('')
      setQuestion('')
      setAnswer('')
    } else {
      const p = card.payload as TheoryPayload
      setQuestion(p.question)
      setAnswer(p.answer)
      setTerm('')
      setTranslation('')
      setContextSentence('')
      setPhraseText('')
      setPattern('')
    }
  }

  const handleSave = async () => {
    if (!card || saving) return
    setSaving(true)
    setError(null)
    try {
      const body =
        card.type === 'vocab'
          ? {
              type: 'vocab',
              payload: {
                term: term.trim(),
                translation: translation.trim(),
                context_sentence: contextSentence.trim(),
              },
            }
          : card.type === 'phrase'
            ? {
                type: 'phrase',
                payload: {
                  phrase: phraseText.trim(),
                  translation: translation.trim(),
                  context_sentence: contextSentence.trim(),
                  ...(pattern.trim() ? { pattern: pattern.trim() } : {}),
                },
              }
            : {
                type: 'theory',
                payload: {
                  question: question.trim(),
                  answer: answer.trim(),
                },
              }
      const res = await fetchWithAuth(`/cards/${card.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `HTTP ${res.status}`)
      }
      const data = (await res.json()) as { card: { payload: VocabPayload | TheoryPayload | PhrasePayload } }
      onSaved({ ...card, payload: data.card.payload })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('edit.error_failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <BottomSheet isOpen={isOpen && card !== null} onClose={onClose}>
      {card && (
        <>
            <div className="flex justify-between items-center mb-4 text-app-text">
              <h2 className="text-xl font-bold">{t('edit.title')}</h2>
              <button
                onClick={onClose}
                className="p-2 -mr-2 text-app-hint active:scale-95 transition-transform"
                aria-label={t('common.close')}
              >
                <X size={20} />
              </button>
            </div>

            <div className="flex flex-col gap-3">
              {card.type === 'vocab' ? (
                <>
                  <Field label={t('edit.field_term')}>
                    <input
                      type="text"
                      value={term}
                      onChange={(e) => setTerm(e.target.value)}
                      className="w-full bg-app-surface text-app-text border border-app-border rounded-xl py-3 px-4 focus:outline-none focus:border-app-primary"
                      autoCapitalize="off"
                      autoCorrect="off"
                    />
                  </Field>
                  <Field label={t('edit.field_translation')}>
                    <input
                      type="text"
                      value={translation}
                      onChange={(e) => setTranslation(e.target.value)}
                      className="w-full bg-app-surface text-app-text border border-app-border rounded-xl py-3 px-4 focus:outline-none focus:border-app-primary"
                    />
                  </Field>
                  <Field label={t('edit.field_context')}>
                    <textarea
                      value={contextSentence}
                      onChange={(e) => setContextSentence(e.target.value)}
                      rows={3}
                      className="w-full bg-app-surface text-app-text border border-app-border rounded-xl py-3 px-4 focus:outline-none focus:border-app-primary resize-none"
                    />
                  </Field>
                  <p className="text-[11px] text-app-hint leading-snug">
                    {t('edit.hint_offset')}
                  </p>
                </>
              ) : card.type === 'phrase' ? (
                <>
                  <Field label={t('edit.field_phrase')}>
                    <textarea
                      value={phraseText}
                      onChange={(e) => setPhraseText(e.target.value)}
                      rows={2}
                      className="w-full bg-app-surface text-app-text border border-app-border rounded-xl py-3 px-4 focus:outline-none focus:border-app-primary resize-none"
                      autoCapitalize="off"
                      autoCorrect="off"
                    />
                  </Field>
                  <Field label={t('edit.field_translation')}>
                    <input
                      type="text"
                      value={translation}
                      onChange={(e) => setTranslation(e.target.value)}
                      className="w-full bg-app-surface text-app-text border border-app-border rounded-xl py-3 px-4 focus:outline-none focus:border-app-primary"
                    />
                  </Field>
                  <Field label={t('edit.field_context')}>
                    <textarea
                      value={contextSentence}
                      onChange={(e) => setContextSentence(e.target.value)}
                      rows={3}
                      className="w-full bg-app-surface text-app-text border border-app-border rounded-xl py-3 px-4 focus:outline-none focus:border-app-primary resize-none"
                    />
                  </Field>
                  <Field label={t('edit.field_pattern')}>
                    <input
                      type="text"
                      value={pattern}
                      onChange={(e) => setPattern(e.target.value)}
                      placeholder={t('edit.field_pattern_placeholder')}
                      className="w-full bg-app-surface text-app-text border border-app-border rounded-xl py-3 px-4 font-mono text-sm focus:outline-none focus:border-app-primary"
                      autoCapitalize="off"
                      autoCorrect="off"
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field label={t('edit.field_question')}>
                    <textarea
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      rows={2}
                      className="w-full bg-app-surface text-app-text border border-app-border rounded-xl py-3 px-4 focus:outline-none focus:border-app-primary resize-none"
                    />
                  </Field>
                  <Field label={t('edit.field_answer')}>
                    <textarea
                      value={answer}
                      onChange={(e) => setAnswer(e.target.value)}
                      rows={8}
                      className="w-full bg-app-surface text-app-text border border-app-border rounded-xl py-3 px-4 focus:outline-none focus:border-app-primary resize-none font-mono text-sm"
                    />
                  </Field>
                </>
              )}

              {error && (
                <p className="text-sm text-rose-500 bg-rose-500/10 rounded-lg px-3 py-2">
                  {error}
                </p>
              )}

              <button
                onClick={handleSave}
                disabled={saving}
                className="mt-2 flex items-center justify-center gap-2 py-3 rounded-2xl bg-app-primary text-app-primary-text font-semibold active:scale-95 transition-transform disabled:opacity-50"
              >
                <Save size={16} />
                {saving ? t('edit.btn_saving') : t('edit.btn_save')}
              </button>
            </div>

          <div style={{ height: 'calc(0.5rem + var(--tg-safe-area-inset-bottom, 0px))' }} />
        </>
      )}
    </BottomSheet>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] uppercase tracking-widest text-app-hint font-bold">
        {label}
      </span>
      {children}
    </label>
  )
}
