import { useQuery } from '@tanstack/react-query'
import { BottomSheet } from './BottomSheet'
import { BookOpen, Quote, Type, X, HelpCircle } from 'lucide-react'
import type { CardListDto, PhrasePayload, TheoryPayload, VocabPayload } from '@oxenfurt/shared'
import { getScopeSlug } from '../lib/scope'
import { fetchWithAuth } from '../lib/api'
import { useT } from '../lib/i18n/useT'

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
  const t = useT()
  const { data, isLoading } = useQuery({
    queryKey: [getScopeSlug() ?? 'no-scope', 'cards', cardId, 'related'],
    enabled: isOpen && cardId !== null && source !== null,
    queryFn: async () => {
      const res = await fetchWithAuth(`/cards/${cardId}/related`)
      if (!res.ok) throw new Error('Failed to load related')
      return (await res.json()) as { cards: CardListDto[] }
    },
  })

  const related = data?.cards ?? []

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} maxHeight="75vh">
      <div className="flex justify-between items-center mb-4 text-app-text">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold mb-0.5">
            {t('related.from_lesson')}
          </div>
          <h2 className="text-lg font-bold leading-tight">{source ?? '—'}</h2>
        </div>
        <button
          onClick={onClose}
          className="p-2 -mr-2 text-app-hint active:scale-95 transition-transform"
          aria-label={t('common.close')}
        >
          <X size={20} />
        </button>
      </div>

      {isLoading ? (
        <p className="text-center text-app-hint py-6 text-sm">{t('common.loading')}</p>
      ) : related.length === 0 ? (
        <p className="text-center text-app-hint py-6 text-sm">{t('related.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {related.map((c) => (
            <RelatedRow key={c.id} card={c} />
          ))}
        </ul>
      )}

      <div style={{ height: 'calc(0.5rem + var(--tg-safe-area-inset-bottom, 0px))' }} />
    </BottomSheet>
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
          <div className="font-semibold text-app-text flex items-center gap-2">
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
          <Icon size={12} strokeWidth={2.5} />
        </span>
      </div>
    </li>
  )
}
