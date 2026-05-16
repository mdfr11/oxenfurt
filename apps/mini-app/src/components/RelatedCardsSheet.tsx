import { useQuery } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { X, BookOpen, Quote, Type } from 'lucide-react'
import type { CardListDto, PhrasePayload, TheoryPayload, VocabPayload } from '@oxenfurt/shared'
import { fetchWithAuth } from '../lib/api'

interface Props {
  cardId: string | null
  source: string | null
  isOpen: boolean
  onClose: () => void
}

// Surfaces other active cards from the same lesson source. Read-only — the
// user can browse to see what else came from this lesson, but cannot drill
// in mid-session (would derail the FSRS flow). For deep work, jump to the
// Library which already supports filtering by source.
export function RelatedCardsSheet({ cardId, source, isOpen, onClose }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['cards', cardId, 'related'],
    enabled: isOpen && cardId !== null && source !== null,
    queryFn: async () => {
      const res = await fetchWithAuth(`/cards/${cardId}/related`)
      if (!res.ok) throw new Error('Failed to load related')
      return (await res.json()) as { cards: CardListDto[] }
    },
  })

  const related = data?.cards ?? []

  return (
    <AnimatePresence>
      {isOpen && (
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
            className="fixed bottom-0 inset-x-0 bg-app-bg rounded-t-3xl p-6 z-50 shadow-[0_-10px_40px_rgba(0,0,0,0.1)] flex flex-col max-w-[500px] mx-auto max-h-[75vh] overflow-y-auto"
          >
            <div className="flex justify-between items-center mb-4 text-app-text">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold mb-0.5">
                  Из этого урока
                </div>
                <h2 className="text-lg font-bold leading-tight">{source ?? '—'}</h2>
              </div>
              <button
                onClick={onClose}
                className="p-2 -mr-2 text-app-hint active:scale-95 transition-transform"
                aria-label="Закрыть"
              >
                <X size={20} />
              </button>
            </div>

            {isLoading ? (
              <p className="text-center text-app-hint py-6 text-sm">Загружаю…</p>
            ) : related.length === 0 ? (
              <p className="text-center text-app-hint py-6 text-sm">
                Других активных карточек из этого урока нет
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {related.map((c) => (
                  <RelatedRow key={c.id} card={c} />
                ))}
              </ul>
            )}

            <div style={{ height: 'calc(0.5rem + var(--tg-safe-area-inset-bottom, 0px))' }} />
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

function RelatedRow({ card }: { card: CardListDto }) {
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
    <li className="p-3 rounded-xl bg-app-surface border border-app-border">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate text-app-text">{title}</div>
          <div className="text-xs text-app-hint truncate mt-0.5">{subtitle}</div>
        </div>
        <span className={`shrink-0 mt-0.5 ${iconClass}`}>
          <Icon size={12} strokeWidth={2.5} />
        </span>
      </div>
    </li>
  )
}
