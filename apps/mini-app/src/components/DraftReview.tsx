import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import {
  backButton,
  hapticFeedback,
} from '@telegram-apps/sdk-react'
import { Spinner } from '@telegram-apps/telegram-ui'
import type { DraftCardDto, TheoryPayload } from '@oxenfurt/shared'
import { fetchWithAuth } from '../lib/api'

interface DraftReviewProps {
  onExit: () => void
}

function safeHaptic<T extends keyof typeof hapticFeedback>(
  method: T,
  ...args: Parameters<typeof hapticFeedback[T]>
): void {
  try {
    (hapticFeedback[method] as (...a: typeof args) => void)(...args)
  } catch {
    // SDK not mounted in dev — ignore
  }
}

export function DraftReview({ onExit }: DraftReviewProps) {
  const queryClient = useQueryClient()
  const [index, setIndex] = useState(0)
  const [decided, setDecided] = useState({ approved: 0, skipped: 0 })

  const { data, isLoading, error } = useQuery({
    queryKey: ['cards', 'drafts'],
    queryFn: async () => {
      const res = await fetchWithAuth('/cards/drafts')
      if (!res.ok) throw new Error('Failed to fetch drafts')
      return (await res.json()) as { cards: DraftCardDto[] }
    },
  })

  // BackButton — exit to Home with no confirm; nothing destructive lost.
  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    try {
      backButton.show()
      unsubscribe = backButton.onClick(() => onExit())
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

  const drafts = useMemo(() => data?.cards ?? [], [data])
  const current = drafts[index]

  const decide = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'approve' | 'skip' }) => {
      const res = await fetchWithAuth(`/cards/${id}/${action}`, { method: 'POST' })
      if (!res.ok) throw new Error(`Failed to ${action}`)
      return res.json()
    },
    onSuccess: () => {
      // Refresh /cards/due so Home can update its "ready to practice" hint.
      void queryClient.invalidateQueries({ queryKey: ['cards', 'due'] })
    },
  })

  const handle = (action: 'approve' | 'skip') => {
    if (!current) return
    safeHaptic(
      'notificationOccurred',
      action === 'approve' ? 'success' : 'warning',
    )
    setDecided((prev) => ({
      approved: prev.approved + (action === 'approve' ? 1 : 0),
      skipped: prev.skipped + (action === 'skip' ? 1 : 0),
    }))
    decide.mutate({ id: current.id, action })
    setIndex((i) => i + 1)
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner size="l" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <h2 className="text-xl font-bold mb-2">Не удалось загрузить</h2>
        <button onClick={onExit} className="text-tg-link font-semibold">
          Вернуться
        </button>
      </div>
    )
  }

  if (drafts.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <h2 className="text-xl font-bold mb-2">Очередь пуста</h2>
        <p className="text-tg-hint mb-6">Новых theory-карточек на одобрение нет.</p>
        <button onClick={onExit} className="text-tg-link font-semibold">
          Вернуться
        </button>
      </div>
    )
  }

  // Past the last draft — summary + auto-exit.
  if (current === undefined) {
    return (
      <div
        className="flex-1 flex flex-col p-6 justify-between bg-tg-bg"
        style={{
          paddingTop: `calc(1.5rem + var(--tg-safe-area-inset-top, 0px))`,
          paddingBottom: `calc(2rem + var(--tg-safe-area-inset-bottom, 0px))`,
        }}
      >
        <div className="flex-1 flex flex-col items-center justify-center text-center">
          <h2 className="text-2xl font-bold mb-3">Готово</h2>
          <p className="text-tg-hint">
            Одобрено: {decided.approved} · Пропущено: {decided.skipped}
          </p>
        </div>
        <button
          className="w-full bg-tg-button text-tg-button-text py-4 rounded-xl font-semibold text-lg active:scale-95 transition-transform shadow-md"
          onClick={onExit}
        >
          На главную
        </button>
      </div>
    )
  }

  const theory = current.type === 'theory' ? (current.payload as TheoryPayload) : null

  return (
    <div className="flex-1 flex flex-col bg-tg-bg overflow-hidden">
      <div className="h-1 w-full bg-black/5">
        <motion.div
          className="h-full bg-tg-button"
          initial={{ width: 0 }}
          animate={{ width: `${(index / drafts.length) * 100}%` }}
        />
      </div>

      <div className="p-4 flex justify-between items-center text-[10px] text-tg-hint uppercase tracking-wider font-bold">
        <span>
          {index + 1} / {drafts.length}
        </span>
        <span className="text-tg-link">📖 Theory · черновик</span>
      </div>

      <div className="flex-1 px-4 pb-4 flex items-center justify-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={current.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.15 }}
            className="w-full max-w-md bg-tg-bg rounded-[2rem] p-6 flex flex-col gap-5 border border-black/5 shadow-xl"
          >
            {theory ? (
              <>
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-tg-hint font-bold mb-2">
                    Вопрос
                  </div>
                  <h2 className="text-xl font-bold leading-snug">{theory.question}</h2>
                </div>

                <div>
                  <div className="text-[10px] uppercase tracking-widest text-tg-hint font-bold mb-2">
                    Ответ
                  </div>
                  <p className="text-base leading-relaxed">{theory.answer}</p>
                </div>

                {current.source_quote && (
                  <div className="border-t border-black/5 pt-4">
                    <div className="text-[10px] uppercase tracking-widest text-tg-hint font-bold mb-2">
                      Из урока
                    </div>
                    <p className="text-sm italic text-tg-hint leading-relaxed">
                      «{current.source_quote}»
                    </p>
                    {current.source && (
                      <p className="text-[10px] text-tg-hint opacity-60 mt-2 uppercase tracking-wider">
                        {current.source}
                      </p>
                    )}
                  </div>
                )}
              </>
            ) : (
              <p className="text-base">Неподдерживаемый тип черновика: {current.type}</p>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      <div
        className="px-4 pt-2 flex gap-2"
        style={{ paddingBottom: `calc(1.5rem + var(--tg-safe-area-inset-bottom, 0px))` }}
      >
        <button
          onClick={() => handle('skip')}
          className="flex-1 py-4 rounded-xl border border-black/10 bg-tg-bg text-rose-500 font-semibold active:scale-95 transition-transform"
        >
          Пропустить
        </button>
        <button
          onClick={() => handle('approve')}
          className="flex-1 py-4 rounded-xl bg-emerald-500 text-white font-semibold active:scale-95 transition-transform shadow-md"
        >
          Одобрить
        </button>
      </div>
    </div>
  )
}
