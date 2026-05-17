import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Send } from 'lucide-react'
import { fetchWithAuth } from '../lib/api'

interface Props {
  cardId: string | null
  isOpen: boolean
  onClose: () => void
}

// Card-specific question sheet. The user types whatever is unclear; on
// submit it's persisted with status='pending' and Hermes will pick it up
// async. No spinner waiting on an LLM in-session — the user can return to
// it later via the Home badge.
export function QuestionSheet({ cardId, isOpen, onClose }: Props) {
  const [text, setText] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')

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
      setTimeout(() => {
        setState('idle')
        onClose()
      }, 1200)
    } catch {
      setState('error')
    }
  }

  return (
    <AnimatePresence>
      {isOpen && cardId && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/40 z-40"
          />
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
            className="fixed bottom-0 inset-x-0 bg-app-bg rounded-t-3xl p-6 z-50 shadow-[0_-10px_40px_rgba(0,0,0,0.1)] flex flex-col max-w-[500px] mx-auto max-h-[90vh] overflow-y-auto"
          >
            <div className="flex justify-between items-start mb-3 text-app-text">
              <div>
                <h2 className="text-lg font-bold leading-tight">❓ Что непонятно?</h2>
                <p className="text-[11px] text-app-hint mt-0.5">
                  Агент разберёт после сессии и пришлёт ответ
                </p>
              </div>
              <button
                onClick={onClose}
                className="p-2 -mr-2 text-app-hint active:scale-95 transition-transform"
                aria-label="Закрыть"
              >
                <X size={20} />
              </button>
            </div>

            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              autoFocus
              placeholder="Напр. «не понимаю разницу с look at» или «когда уместно?»"
              className="w-full bg-app-surface text-app-text border border-app-border rounded-xl py-3 px-4 focus:outline-none focus:border-app-primary resize-none text-sm"
              disabled={state === 'sending' || state === 'sent'}
            />

            <button
              onClick={handleSubmit}
              disabled={text.trim().length === 0 || state === 'sending' || state === 'sent'}
              className="mt-3 flex items-center justify-center gap-2 py-3 rounded-2xl bg-app-primary text-app-primary-text font-semibold active:scale-95 transition-transform disabled:opacity-50"
            >
              <Send size={16} />
              {state === 'sending' ? 'Отправляю…' : state === 'sent' ? 'Отправлено ✓' : 'Спросить'}
            </button>

            {state === 'error' && (
              <p className="text-xs text-rose-500 mt-2 text-center">
                Не удалось отправить — попробуй ещё раз
              </p>
            )}

            <div style={{ height: 'calc(0.5rem + var(--tg-safe-area-inset-bottom, 0px))' }} />
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
