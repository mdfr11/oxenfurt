import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  backButton,
  disableVerticalSwipes,
  enableVerticalSwipes,
  hapticFeedback,
  popup,
} from '@telegram-apps/sdk-react';
import { Spinner } from '@telegram-apps/telegram-ui';
import {
  RATING,
  type DueCardDto,
  type Rating,
  type TheoryPayload,
  type VocabPayload,
} from '@oxenfurt/shared';
import { fetchWithAuth } from '../lib/api';
import { formatInterval, previewIntervals } from '../lib/fsrs';

interface PracticeSessionProps {
  onComplete: (total: number, correct: number) => void;
  onExit: () => void;
}

function safeHaptic<T extends keyof typeof hapticFeedback>(method: T, ...args: Parameters<typeof hapticFeedback[T]>): void {
  try {
    (hapticFeedback[method] as (...a: typeof args) => void)(...args)
  } catch {
    // SDK not initialised (dev outside Telegram) — silently ignore
  }
}

export function PracticeSession({ onComplete, onExit }: PracticeSessionProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['cards', 'due'],
    queryFn: async () => {
      const res = await fetchWithAuth('/cards/due');
      if (!res.ok) throw new Error('Failed to fetch cards');
      return (await res.json()) as { cards: DueCardDto[] };
    },
  });

  const [currentIndex, setCurrentIndex] = useState(0);
  const [isRevealed, setIsRevealed] = useState(false);
  const [sessionStats, setSessionStats] = useState({ total: 0, correct: 0 });

  // Disable Telegram's vertical-swipe-to-close while a card flow is active —
  // otherwise a rating gesture can collapse the Mini App. Re-enable on unmount.
  useEffect(() => {
    try {
      disableVerticalSwipes()
    } catch {
      // SDK not mounted (dev outside Telegram) — fine
    }
    return () => {
      try {
        enableVerticalSwipes()
      } catch {
        // ditto
      }
    }
  }, [])

  // BackButton with a confirm sheet — Telegram shows a native one on tap.
  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    try {
      backButton.show()
      unsubscribe = backButton.onClick(async () => {
        try {
          const result = await popup.open({
            title: 'Завершить сессию?',
            message: 'Прогресс сохранён. Можно вернуться позже.',
            buttons: [
              { id: 'stay', type: 'cancel' },
              { id: 'leave', type: 'destructive', text: 'Выйти' },
            ],
          })
          if (result === 'leave') onExit()
        } catch {
          // popup unavailable — exit immediately
          onExit()
        }
      })
    } catch {
      // BackButton not available (dev) — nothing to wire up
    }
    return () => {
      try {
        unsubscribe?.()
        backButton.hide()
      } catch {
        // SDK not mounted — ignore
      }
    }
  }, [onExit])

  const reviewMutation = useMutation({
    mutationFn: async ({ id, rating }: { id: string; rating: Rating }) => {
      const res = await fetchWithAuth(`/cards/${id}/review`, {
        method: 'POST',
        body: JSON.stringify({ rating }),
      });
      if (!res.ok) throw new Error('Failed to submit review');
      return res.json();
    },
  });

  const cards = data?.cards ?? [];
  const currentCard = cards[currentIndex];
  const progress = cards.length > 0 ? (currentIndex / cards.length) * 100 : 0;

  const intervalLabels = useMemo(() => {
    if (!currentCard) return null
    const preview = previewIntervals(currentCard.fsrs, new Date())
    return {
      1: formatInterval(preview[1].days),
      2: formatInterval(preview[2].days),
      3: formatInterval(preview[3].days),
      4: formatInterval(preview[4].days),
    }
  }, [currentCard])

  const handleReveal = () => {
    if (!isRevealed) {
      setIsRevealed(true);
      safeHaptic('impactOccurred', 'light')
    }
  };

  const handleRate = (rating: Rating) => {
    if (!currentCard) return;

    if (rating === RATING.Again) safeHaptic('notificationOccurred', 'error')
    else if (rating === RATING.Hard) safeHaptic('impactOccurred', 'medium')
    else if (rating === RATING.Good) safeHaptic('selectionChanged')
    else safeHaptic('notificationOccurred', 'success')

    const isCorrect = rating !== RATING.Again;
    const nextStats = {
      total: sessionStats.total + 1,
      correct: sessionStats.correct + (isCorrect ? 1 : 0),
    }
    setSessionStats(nextStats)

    // Optimistically advance; submit in background.
    reviewMutation.mutate({ id: currentCard.id, rating });

    if (currentIndex < cards.length - 1) {
      setIsRevealed(false);
      setCurrentIndex((idx) => idx + 1);
    } else {
      safeHaptic('notificationOccurred', 'success')
      onComplete(nextStats.total, nextStats.correct);
    }
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner size="l" />
      </div>
    );
  }

  if (error || cards.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <h2 className="text-xl font-bold mb-2">Нет карточек на сегодня</h2>
        <p className="text-tg-hint mb-6">Отдыхай или загрузи новый транскрипт!</p>
        <button onClick={onExit} className="text-tg-link font-semibold">Вернуться</button>
      </div>
    );
  }

  const vocab = currentCard!.type === 'vocab' ? (currentCard!.payload as VocabPayload) : null;
  const theory = currentCard!.type === 'theory' ? (currentCard!.payload as TheoryPayload) : null;

  // Split sentence logic for target term highlighting
  const renderSentenceWithHighlight = (sentence: string, term: string) => {
    if (!term || !sentence.includes(term)) return <p className="text-xl leading-relaxed">{sentence}</p>;
    
    const parts = sentence.split(new RegExp(`(${term})`, 'gi'));
    
    return (
      <p className="text-xl leading-relaxed">
        {parts.map((part, i) => 
          part.toLowerCase() === term.toLowerCase() 
            ? <span key={i} className="text-tg-link font-bold underline decoration-2 underline-offset-4">{part}</span>
            : <span key={i}>{part}</span>
        )}
      </p>
    );
  };

  return (
    <div className="flex-1 flex flex-col bg-tg-bg overflow-hidden">
      {/* Progress Bar */}
      <div className="h-1 w-full bg-black/5">
        <motion.div
          className="h-full bg-tg-button"
          initial={{ width: 0 }}
          animate={{ width: `${progress}%` }}
        />
      </div>

      <div className="p-4 flex justify-between items-center text-[10px] text-tg-hint uppercase tracking-wider font-bold">
        <span>Карточка {currentIndex + 1} / {cards.length}</span>
        {currentCard!.type === 'theory' && <span className="text-tg-link">📖 Theory</span>}
      </div>

      <div className="flex-1 px-4 flex items-center justify-center">
        <motion.div
          onClick={handleReveal}
          className="w-full aspect-[3/4] bg-tg-bg rounded-[2.5rem] p-8 flex flex-col items-center justify-center text-center relative border border-black/5 shadow-xl cursor-pointer"
          whileTap={{ scale: 0.98 }}
        >
          <AnimatePresence mode="wait">
            {!isRevealed ? (
              <motion.div
                key="front"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.1 }}
                className="flex flex-col items-center gap-6"
              >
                {vocab ? (
                  <>
                    <h2 className="text-4xl font-bold tracking-tight">
                      {vocab.term}
                    </h2>
                    <p className="text-xl text-tg-text leading-relaxed">
                      "{vocab.context_sentence}"
                    </p>
                  </>
                ) : theory ? (
                  <h2 className="text-2xl font-bold">
                    {theory.question}
                  </h2>
                ) : null}
                {currentCard!.source && (
                  <div className="absolute bottom-10 text-[10px] text-tg-hint uppercase tracking-[0.2em] font-bold opacity-40">
                    {currentCard!.source}
                  </div>
                )}
              </motion.div>
            ) : (
              <motion.div
                key="back"
                initial={{ opacity: 0, scale: 1.1 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col items-center gap-6"
              >
                {vocab ? (
                  <>
                    <span className="bg-tg-button/10 text-tg-button px-4 py-1 rounded-full text-xs font-bold uppercase tracking-widest">
                      {vocab.translation}
                    </span>
                    {renderSentenceWithHighlight(vocab.context_sentence, vocab.term)}
                  </>
                ) : theory ? (
                  <>
                    <p className="text-xl">{theory.answer}</p>
                    {currentCard!.source_quote && (
                      <p className="text-sm text-tg-hint italic">
                        Из урока: «{currentCard!.source_quote}»
                      </p>
                    )}
                  </>
                ) : null}
              </motion.div>
            )}
          </AnimatePresence>

          {!isRevealed && (
            <div className="absolute inset-x-0 bottom-4 text-[9px] text-tg-hint opacity-30 uppercase font-bold tracking-[0.3em]">
              Tap to reveal
            </div>
          )}
        </motion.div>
      </div>

      {/* Rating Buttons */}
      <div
        className={`px-2 pb-10 pt-4 transition-all duration-300 ${
          isRevealed ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'
        }`}
        style={{ paddingBottom: `calc(2.5rem + var(--tg-safe-area-inset-bottom, 0px))` }}
      >
        <div className="flex gap-2 h-16">
          <RatingButton label="Снова" sub={intervalLabels?.[RATING.Again] ?? '…'} color="text-rose-500" onClick={() => handleRate(RATING.Again)} />
          <RatingButton label="Трудно" sub={intervalLabels?.[RATING.Hard] ?? '…'} color="text-orange-500" onClick={() => handleRate(RATING.Hard)} />
          <RatingButton label="Хорошо" sub={intervalLabels?.[RATING.Good] ?? '…'} color="text-blue-500" onClick={() => handleRate(RATING.Good)} />
          <RatingButton label="Легко" sub={intervalLabels?.[RATING.Easy] ?? '…'} color="text-emerald-500" onClick={() => handleRate(RATING.Easy)} />
        </div>
      </div>
    </div>
  );
}

function RatingButton({ label, sub, color, onClick }: { label: string; sub: string; color: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex-1 flex flex-col items-center justify-center gap-0.5 rounded-2xl border border-black/5 bg-tg-bg active:scale-95 transition-transform"
    >
      <span className={`text-[13px] font-bold ${color}`}>{label}</span>
      <span className="text-[10px] text-tg-hint font-medium opacity-60 uppercase">{sub}</span>
    </button>
  );
}
