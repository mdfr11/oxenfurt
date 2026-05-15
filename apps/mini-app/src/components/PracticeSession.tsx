import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { motion, AnimatePresence, type PanInfo } from 'framer-motion';
import { Coffee, X } from 'lucide-react';
import {
  backButton,
  disableVerticalSwipes,
  enableVerticalSwipes,
  hapticFeedback,
  popup,
} from '@telegram-apps/sdk-react';
import {
  RATING,
  matchAnswer,
  type DueCardDto,
  type MatchResult,
  type Rating,
  type TheoryPayload,
  type VocabPayload,
} from '@oxenfurt/shared';
import { fetchWithAuth } from '../lib/api';
import { formatInterval, previewIntervals } from '../lib/fsrs';
import { playPopSound, playSuccessChime, playThudSound } from '../lib/audio';
import { pickVariantFor, type PracticeMode, type ExerciseVariant } from '../lib/practiceMode';
import { speak, stopSpeaking } from '../lib/tts';
import { cycleTtsSpeed, labelForSpeed, loadTtsSpeed, rateForSpeed, saveTtsSpeed, type TtsSpeed } from '../lib/audioSettings';

interface PracticeSessionProps {
  mode: PracticeMode;
  onComplete: (total: number, correct: number) => void;
  onExit: () => void;
}

import { getSettings } from '../lib/settings';

function safeHaptic<T extends keyof typeof hapticFeedback>(method: T, ...args: Parameters<typeof hapticFeedback[T]>): void {
  try {
    const { hapticsEnabled } = getSettings();
    if (!hapticsEnabled) return;
    (hapticFeedback[method] as (...a: typeof args) => void)(...args)
  } catch {
    // SDK not initialised (dev outside Telegram) — silently ignore
  }
}

export function PracticeSession({ mode, onComplete, onExit }: PracticeSessionProps) {
  // When the FSRS-due queue is empty but the user still wants to drill, they
  // can opt into bypass mode from the empty state. Ratings still update FSRS
  // state — early-reviewed cards just get rescheduled normally.
  const [bypassDue, setBypassDue] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['cards', 'due', bypassDue],
    queryFn: async () => {
      const path = bypassDue ? '/cards/due?bypass_due=true&limit=50' : '/cards/due'
      const res = await fetchWithAuth(path);
      if (!res.ok) throw new Error('Failed to fetch cards');
      return (await res.json()) as { cards: DueCardDto[] };
    },
  });

  const [currentIndex, setCurrentIndex] = useState(0);
  const [isRevealed, setIsRevealed] = useState(false);
  const [sessionStats, setSessionStats] = useState({ total: 0, correct: 0 });
  // Cloze-only state — reset on each card via the effect below.
  const [typedAnswer, setTypedAnswer] = useState('');
  const [matchResult, setMatchResult] = useState<MatchResult | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Undo functionality state
  const [pendingReview, setPendingReview] = useState<{ id: string; rating: Rating; timeoutId: number; previousIndex: number; previousStats: typeof sessionStats } | null>(null);

  // Backend session id (UUID). Set once on mount via POST /sessions, then
  // used by finishSession() on completion. Fire-and-forget — if the start
  // request fails, sessionIdRef stays null and the finish call is skipped.
  // The local practice flow doesn't depend on it.
  const sessionIdRef = useRef<string | null>(null)
  const sessionFinishedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetchWithAuth('/sessions', { method: 'POST' })
        if (!res.ok) return
        const body = (await res.json()) as { id: string }
        if (!cancelled) sessionIdRef.current = body.id
      } catch {
        // Backend unreachable — practice still works locally untracked.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

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

  // Flush any pending review on unmount — the undo-window timer is in-memory
  // only, so if the user exits before it fires, we still want the rating
  // to land on the server.
  useEffect(() => {
    return () => {
      if (pendingReview) {
        clearTimeout(pendingReview.timeoutId);
        reviewMutation.mutate({ id: pendingReview.id, rating: pendingReview.rating });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReview]);

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

  // Resolve the exercise variant for the current card. Theory always
  // degrades to `recognition` — it has no term to type or audio to test on.
  const variant: ExerciseVariant =
    currentCard === undefined
      ? 'recognition'
      : currentCard.type === 'theory'
        ? 'recognition'
        : pickVariantFor(mode, currentCard.id)

  const expectsTypedAnswer = variant === 'cloze' || variant === 'translation' || variant === 'listening'

  // Reset typed answer + match feedback when the active card changes.
  // React 19 idiomatic: set state during render when an upstream identity
  // shifts. The setState calls below get coalesced into one re-render.
  const [seenCardId, setSeenCardId] = useState<string | undefined>(undefined)
  if (currentCard?.id !== seenCardId) {
    setSeenCardId(currentCard?.id)
    setTypedAnswer('')
    setMatchResult(null)
  }

  // Don't auto-focus the input — the soft keyboard popping up on every
  // new card is more disruptive than it is helpful, especially in cloze /
  // listening where the user wants to read or hear the prompt first.
  // They tap the input themselves when ready.
  void inputRef // keep the ref reachable for the field, even if we don't focus


  // Persisted TTS speed preference — toggle via the chip below the 🔊 button.
  const [ttsSpeed, setTtsSpeed] = useState<TtsSpeed>(() => loadTtsSpeed())

  // Listening variant: pronounce the term on card show.
  useEffect(() => {
    if (variant === 'listening' && !isRevealed && currentCard?.type === 'vocab') {
      const vocab = currentCard.payload as VocabPayload
      // Small delay so the card animation finishes before audio starts.
      const t = setTimeout(() => { void speak(vocab.term, { rate: rateForSpeed(ttsSpeed) }) }, 250)
      return () => {
        clearTimeout(t)
        stopSpeaking()
      }
    }
    return undefined
  }, [currentCard?.id, variant, isRevealed, currentCard, ttsSpeed])

  // Stop any pronunciation when leaving the screen.
  useEffect(() => () => stopSpeaking(), [])

  const handleReveal = () => {
    // Typed variants reveal via submit, not tap.
    if (expectsTypedAnswer) return
    // Recognition: tap toggles reveal — second tap flips back to the front.
    setIsRevealed((prev) => !prev)
    safeHaptic('impactOccurred', 'light')
    playPopSound()
  };

  const cycleSpeed = () => {
    const next = cycleTtsSpeed(ttsSpeed)
    setTtsSpeed(next)
    saveTtsSpeed(next)
    safeHaptic('selectionChanged')
  };

  const handleAnswerSubmit = () => {
    if (isRevealed || !expectsTypedAnswer || !currentCard || currentCard.type !== 'vocab') return;
    const vocabPayload = currentCard.payload as VocabPayload;
    const expected =
      variant === 'cloze'
        ? extractClozeTerm(vocabPayload)
        : vocabPayload.term;
    const result = matchAnswer(typedAnswer, expected);
    setMatchResult(result);
    setIsRevealed(true);
    if (result.kind === 'exact') { safeHaptic('notificationOccurred', 'success'); playPopSound(); }
    else if (result.kind === 'close') { safeHaptic('impactOccurred', 'medium'); playPopSound(); }
    else { safeHaptic('notificationOccurred', 'error'); playThudSound(); }
  };

  const handleReplayAudio = () => {
    if (currentCard?.type !== 'vocab') return
    const vocab = currentCard.payload as VocabPayload
    void speak(vocab.term, { rate: rateForSpeed(ttsSpeed) })
    safeHaptic('selectionChanged')
  };

  // "I don't know" / "show me the answer" — bypass fuzzy match entirely and
  // reveal the card. No match feedback chip is shown (the user wasn't testing
  // a guess), and the FSRS rating is still theirs to pick — they might want
  // Hard if they almost had it, or Again if they were clueless.
  const handleGiveUp = () => {
    if (isRevealed || !expectsTypedAnswer || !currentCard) return
    setMatchResult(null)
    setIsRevealed(true)
    safeHaptic('impactOccurred', 'light')
    playThudSound()
  };

  const handleRate = (rating: Rating) => {
    if (!currentCard) return;

    if (rating === RATING.Again) { safeHaptic('notificationOccurred', 'error'); playThudSound(); }
    else if (rating === RATING.Hard) { safeHaptic('impactOccurred', 'medium'); playPopSound(); }
    else if (rating === RATING.Good) { safeHaptic('selectionChanged'); playPopSound(); }
    else { safeHaptic('notificationOccurred', 'success'); playPopSound(); }

    const isCorrect = rating !== RATING.Again;
    const nextStats = {
      total: sessionStats.total + 1,
      correct: sessionStats.correct + (isCorrect ? 1 : 0),
    }

    // Flush any existing pending review immediately before queueing the next one
    if (pendingReview) {
      clearTimeout(pendingReview.timeoutId);
      reviewMutation.mutate({ id: pendingReview.id, rating: pendingReview.rating });
    }

    // Delay the API call by 3.5 seconds to allow undo
    const timeoutId = window.setTimeout(() => {
      reviewMutation.mutate({ id: currentCard.id, rating });
      setPendingReview(null);
    }, 3500);

    setPendingReview({
      id: currentCard.id,
      rating,
      timeoutId,
      previousIndex: currentIndex,
      previousStats: sessionStats,
    });

    setSessionStats(nextStats)

    // Optimistically advance
    if (currentIndex < cards.length - 1) {
      setIsRevealed(false);
      setCurrentIndex((idx) => idx + 1);
    } else {
      // If it's the last card, we don't allow undo to keep it simple, flush immediately
      clearTimeout(timeoutId);
      setPendingReview(null);
      reviewMutation.mutate({ id: currentCard.id, rating });

      safeHaptic('notificationOccurred', 'success')
      playSuccessChime()
      finishBackendSession(nextStats.total, nextStats.correct)
      onComplete(nextStats.total, nextStats.correct);
    }
  };

  const handleUndo = () => {
    if (!pendingReview) return;
    
    // Cancel the delayed API call
    clearTimeout(pendingReview.timeoutId);
    
    // Revert state
    setCurrentIndex(pendingReview.previousIndex);
    setSessionStats(pendingReview.previousStats);
    setIsRevealed(true);
    setPendingReview(null);
    safeHaptic('selectionChanged');
  };

  // Fire-and-forget. Idempotent — backend rejects double-finish with 400 and
  // sessionFinishedRef prevents us from even sending it twice locally.
  function finishBackendSession(total: number, correct: number): void {
    const id = sessionIdRef.current
    if (id === null || sessionFinishedRef.current) return
    sessionFinishedRef.current = true
    void fetchWithAuth(`/sessions/${id}/finish`, {
      method: 'POST',
      body: JSON.stringify({ cards_reviewed: total, cards_correct: correct }),
    }).catch(() => {
      // Best-effort; do nothing on failure.
    })
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex flex-col bg-app-bg text-app-text overflow-hidden">
        {/* Skeleton Progress Bar */}
        <div className="h-1 w-full bg-black/5 dark:bg-white/5"></div>
        
        <div className="p-4 flex justify-between items-center">
          <div className="h-3 w-20 bg-app-hint/20 rounded animate-pulse"></div>
          <div className="h-7 w-7 rounded-full bg-app-hint/20 animate-pulse"></div>
        </div>

        <div className="flex-1 px-4 flex items-center justify-center">
          <div className="w-full aspect-[3/4] bg-app-surface rounded-[2.5rem] p-8 flex flex-col items-center justify-center text-center relative border border-app-border shadow-xl">
             <div className="flex flex-col items-center gap-6 w-full animate-pulse">
               <div className="h-10 w-3/4 bg-app-hint/20 rounded-lg"></div>
               <div className="h-4 w-5/6 bg-app-hint/20 rounded"></div>
               <div className="h-4 w-4/6 bg-app-hint/20 rounded"></div>
             </div>
             <div className="absolute bottom-10 h-3 w-24 bg-app-hint/20 rounded animate-pulse"></div>
          </div>
        </div>

        {/* Skeleton Rating Buttons */}
        <div className="px-2 pb-10 pt-4" style={{ paddingBottom: `calc(2.5rem + var(--tg-safe-area-inset-bottom, 0px))` }}>
          <div className="flex gap-2 h-16 animate-pulse">
            <div className="flex-1 rounded-2xl bg-app-hint/10"></div>
            <div className="flex-1 rounded-2xl bg-app-hint/10"></div>
            <div className="flex-1 rounded-2xl bg-app-hint/10"></div>
            <div className="flex-1 rounded-2xl bg-app-hint/10"></div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center bg-app-bg text-app-text">
        <div className="w-20 h-20 bg-rose-500/10 border border-rose-500/30 rounded-full flex items-center justify-center text-rose-500 shadow-sm mb-6 text-3xl">
          ⚠
        </div>
        <h2 className="text-2xl font-bold mb-2">Не удалось загрузить</h2>
        <p className="text-app-hint mb-2 max-w-[260px] text-sm">
          {error instanceof Error ? error.message : String(error)}
        </p>
        <p className="text-app-hint mb-10 max-w-[260px] text-xs opacity-60">
          Проверь подключение или попробуй ещё раз.
        </p>
        <button
          onClick={onExit}
          className="w-full bg-app-primary text-app-primary-text py-4 rounded-2xl font-semibold text-lg active:scale-95 transition-transform shadow-lg shadow-app-primary/20"
        >
          На главную
        </button>
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center bg-app-bg text-app-text">
        <div className="w-20 h-20 bg-app-surface border border-app-border rounded-full flex items-center justify-center text-app-primary shadow-sm mb-6">
          <Coffee size={36} strokeWidth={1.5} />
        </div>
        <h2 className="text-2xl font-bold mb-2">
          {bypassDue ? 'Совсем пусто' : 'На сегодня всё'}
        </h2>
        <p className="text-app-hint mb-10 max-w-[260px]">
          {bypassDue
            ? 'Активных карточек нет — загрузи новый транскрипт в бот.'
            : 'FSRS перенёс остальные карточки на потом. Можно отдохнуть — а можно потренироваться вне расписания.'}
        </p>
        <div className="flex flex-col gap-3 w-full">
          {!bypassDue && (
            <button
              onClick={() => {
                setBypassDue(true)
                setCurrentIndex(0)
                setIsRevealed(false)
              }}
              className="w-full bg-app-primary text-app-primary-text py-4 rounded-2xl font-semibold text-lg active:scale-95 transition-transform shadow-lg shadow-app-primary/20"
            >
              Тренировать вне расписания
            </button>
          )}
          <button
            onClick={onExit}
            className={`w-full py-4 rounded-2xl font-semibold text-lg active:scale-95 transition-transform ${
              bypassDue
                ? 'bg-app-primary text-app-primary-text shadow-lg shadow-app-primary/20'
                : 'border border-app-border bg-app-surface text-app-text'
            }`}
          >
            На главную
          </button>
        </div>
      </div>
    );
  }

  const vocab = currentCard!.type === 'vocab' ? (currentCard!.payload as VocabPayload) : null;
  const theory = currentCard!.type === 'theory' ? (currentCard!.payload as TheoryPayload) : null;

  // Sentence with the target term replaced by an underline blank — used as
  // the cloze prompt. Falls back gracefully if the offsets look bogus.
  const clozePrompt = vocab && variant === 'cloze' ? buildClozeSentence(vocab) : null;

  // Split sentence logic for target term highlighting
  const renderSentenceWithHighlight = (sentence: string, term: string) => {
    if (!term || !sentence.includes(term)) return <p className="text-xl leading-relaxed">{sentence}</p>;
    
    const parts = sentence.split(new RegExp(`(${term})`, 'gi'));
    
    return (
      <p className="text-xl leading-relaxed">
        {parts.map((part, i) => 
          part.toLowerCase() === term.toLowerCase() 
            ? <span key={i} className="text-app-primary font-bold underline decoration-2 underline-offset-4">{part}</span>
            : <span key={i}>{part}</span>
        )}
      </p>
    );
  };

  return (
    <div className="flex-1 flex flex-col bg-app-bg text-app-text overflow-hidden">
      {/* Progress Bar */}
      <div className="h-1 w-full bg-black/5 dark:bg-white/5">
        <motion.div
          className="h-full bg-app-primary"
          initial={{ width: 0 }}
          animate={{ width: `${progress}%` }}
        />
      </div>

      <div className="p-4 flex justify-between items-center text-[10px] text-app-hint uppercase tracking-wider font-bold">
        <span>Карточка {currentIndex + 1} / {cards.length}</span>
        <div className="flex items-center gap-3">
          {currentCard!.type === 'theory' && <span className="text-app-primary">📖 Theory</span>}
          <button
            onClick={onExit}
            className="w-7 h-7 flex items-center justify-center rounded-full bg-black/5 dark:bg-white/10 text-app-hint active:scale-95 transition-transform"
            aria-label="Завершить сессию"
          >
            <X size={16} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      <div className="flex-1 px-4 flex items-center justify-center">
        <motion.div
          onClick={expectsTypedAnswer ? undefined : handleReveal}
          drag={isRevealed}
          dragConstraints={{ left: 0, right: 0, top: 0, bottom: 0 }}
          dragElastic={0.6}
          onDragEnd={(_, info: PanInfo) => {
            if (!isRevealed) return;
            const { offset } = info;
            const threshold = 100;
            if (Math.abs(offset.x) > Math.abs(offset.y)) {
              if (offset.x > threshold) handleRate(RATING.Good);
              else if (offset.x < -threshold) handleRate(RATING.Hard);
            } else {
              if (offset.y > threshold) handleRate(RATING.Again);
              else if (offset.y < -threshold) handleRate(RATING.Easy);
            }
          }}
          className={`w-full aspect-[3/4] bg-app-surface rounded-[2.5rem] p-8 flex flex-col items-center justify-center text-center relative border border-app-border shadow-xl ${
            expectsTypedAnswer ? '' : 'cursor-pointer'
          } ${isRevealed ? 'cursor-grab active:cursor-grabbing' : ''}`}
          whileTap={expectsTypedAnswer ? undefined : { scale: 0.98 }}
        >
          <AnimatePresence mode="wait">
            {!isRevealed ? (
              <motion.div
                key="front"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.1 }}
                className="flex flex-col items-center gap-6 w-full"
              >
                {variant === 'cloze' && vocab && clozePrompt ? (
                  <>
                    <p className="text-lg text-app-text leading-relaxed">
                      {clozePrompt.before}
                      <span className="text-app-primary font-bold">{'_'.repeat(Math.max(3, Math.min(12, clozePrompt.targetLength)))}</span>
                      {clozePrompt.after}
                    </p>
                    <TypedAnswerField
                      inputRef={inputRef}
                      value={typedAnswer}
                      onChange={setTypedAnswer}
                      onSubmit={handleAnswerSubmit}
                      onGiveUp={handleGiveUp}
                      placeholder="Введи пропущенное слово"
                      matchResult={matchResult}
                    />
                  </>
                ) : variant === 'translation' && vocab ? (
                  <>
                    <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold">Перевод</div>
                    <h2 className="text-2xl font-bold leading-snug">{vocab.translation}</h2>
                    <TypedAnswerField
                      inputRef={inputRef}
                      value={typedAnswer}
                      onChange={setTypedAnswer}
                      onSubmit={handleAnswerSubmit}
                      onGiveUp={handleGiveUp}
                      placeholder="Напиши по-английски"
                      matchResult={matchResult}
                    />
                  </>
                ) : variant === 'listening' && vocab ? (
                  <>
                    <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold">Слушай</div>
                    <button
                      onClick={handleReplayAudio}
                      className="w-20 h-20 rounded-full bg-app-primary/10 border border-app-primary/30 flex items-center justify-center text-3xl active:scale-95 transition-transform"
                      aria-label="Replay"
                    >
                      🔊
                    </button>
                    <SpeedChip speed={ttsSpeed} onCycle={cycleSpeed} />
                    <p className="text-[11px] text-app-hint">Тап чтобы повторить</p>
                    <TypedAnswerField
                      inputRef={inputRef}
                      value={typedAnswer}
                      onChange={setTypedAnswer}
                      onSubmit={handleAnswerSubmit}
                      onGiveUp={handleGiveUp}
                      placeholder="Напиши что услышал"
                      matchResult={matchResult}
                    />
                  </>
                ) : vocab ? (
                  <>
                    <div className="flex items-center gap-3">
                      <h2 className="text-4xl font-bold tracking-tight">
                        {vocab.term}
                      </h2>
                      <button
                        onClick={(e) => {
                          e.stopPropagation() // don't trigger card-level handleReveal
                          handleReplayAudio()
                        }}
                        className="w-10 h-10 rounded-full bg-app-primary/10 border border-app-primary/30 flex items-center justify-center text-base active:scale-90 transition-transform"
                        aria-label="Произнести слово"
                      >
                        🔊
                      </button>
                    </div>
                    <div onClick={(e) => e.stopPropagation()}>
                      <SpeedChip speed={ttsSpeed} onCycle={cycleSpeed} />
                    </div>
                    <p className="text-xl text-app-text leading-relaxed">
                      "{vocab.context_sentence}"
                    </p>
                  </>
                ) : theory ? (
                  <h2 className="text-2xl font-bold">
                    {theory.question}
                  </h2>
                ) : null}
                {currentCard!.source && !expectsTypedAnswer && (
                  <div className="absolute bottom-10 text-[10px] text-app-hint uppercase tracking-[0.2em] font-bold opacity-40">
                    {currentCard!.source}
                  </div>
                )}
              </motion.div>
            ) : (
              <motion.div
                key="back"
                initial={{ opacity: 0, scale: 1.1 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col items-center gap-5"
              >
                {matchResult && expectsTypedAnswer && (
                  <ClozeFeedback result={matchResult} typedAnswer={typedAnswer} />
                )}
                {vocab ? (
                  <>
                    <span className="bg-app-primary/10 text-app-primary px-4 py-1 rounded-full text-xs font-bold uppercase tracking-widest">
                      {vocab.translation}
                    </span>
                    {renderSentenceWithHighlight(vocab.context_sentence, vocab.term)}
                  </>
                ) : theory ? (
                  <>
                    <p className="text-xl">{theory.answer}</p>
                    {currentCard!.source_quote && (
                      <p className="text-sm text-app-hint italic">
                        Из урока: «{currentCard!.source_quote}»
                      </p>
                    )}
                  </>
                ) : null}
              </motion.div>
            )}
          </AnimatePresence>

          {!isRevealed && !expectsTypedAnswer && (
            <div className="absolute inset-x-0 bottom-4 text-[9px] text-app-hint opacity-30 uppercase font-bold tracking-[0.3em]">
              Тап чтобы открыть
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
        {/* Tells the user the rating row is the way forward, not a result of
            their typed answer. Empirically the most common confusion. */}
        <p className="text-center text-[10px] text-app-hint uppercase tracking-widest font-bold pb-2 px-3">
          Как легко вспомнил? · тап = следующая карточка
        </p>
        <div className="flex gap-2 h-16 relative">
          <RatingButton label="Снова" sub={intervalLabels?.[RATING.Again] ?? '…'} bg="bg-rose-500/10" color="text-rose-600 dark:text-rose-400" onClick={() => handleRate(RATING.Again)} />
          <RatingButton label="Трудно" sub={intervalLabels?.[RATING.Hard] ?? '…'} bg="bg-orange-500/10" color="text-orange-600 dark:text-orange-400" onClick={() => handleRate(RATING.Hard)} />
          <RatingButton label="Хорошо" sub={intervalLabels?.[RATING.Good] ?? '…'} bg="bg-blue-500/10" color="text-blue-600 dark:text-blue-400" onClick={() => handleRate(RATING.Good)} />
          <RatingButton label="Легко" sub={intervalLabels?.[RATING.Easy] ?? '…'} bg="bg-emerald-500/10" color="text-emerald-600 dark:text-emerald-400" onClick={() => handleRate(RATING.Easy)} />

          <AnimatePresence>
            {pendingReview && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                className="absolute inset-x-2 -top-[4.5rem] flex items-center justify-between bg-app-text text-app-bg px-4 py-3 rounded-xl shadow-lg z-20 pointer-events-auto"
              >
                <span className="text-sm font-medium">
                  Оценено: <span className="font-bold">
                    {pendingReview.rating === RATING.Again && 'Снова'}
                    {pendingReview.rating === RATING.Hard && 'Трудно'}
                    {pendingReview.rating === RATING.Good && 'Хорошо'}
                    {pendingReview.rating === RATING.Easy && 'Легко'}
                  </span>
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleUndo();
                  }}
                  className="text-sm font-bold text-app-bg bg-white/20 px-3 py-1 rounded-lg active:bg-white/30 transition-colors"
                >
                  Отменить
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function TypedAnswerField({
  inputRef,
  value,
  onChange,
  onSubmit,
  onGiveUp,
  placeholder,
  matchResult,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onGiveUp: () => void
  placeholder: string
  matchResult: MatchResult | null
}) {
  const isError = matchResult && matchResult.kind === 'miss';
  const isSuccess = matchResult && (matchResult.kind === 'exact' || matchResult.kind === 'close');

  return (
    <>
      <motion.input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onSubmit()
          }
        }}
        placeholder={placeholder}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        animate={
          isError ? { x: [0, -10, 10, -10, 10, 0] } :
          isSuccess ? { scale: [1, 1.02, 1] } : {}
        }
        transition={{ duration: 0.4 }}
        className={`w-full max-w-[240px] text-center text-lg bg-app-bg border rounded-xl py-3 px-4 focus:outline-none transition-colors ${
          isError ? 'border-rose-500 bg-rose-500/5' :
          isSuccess ? 'border-emerald-500 bg-emerald-500/5' :
          'border-app-border focus:border-app-primary'
        }`}
      />
      <button
        onClick={onSubmit}
        className="w-full max-w-[240px] py-3 rounded-xl bg-app-primary text-app-primary-text font-semibold active:scale-95 transition-transform"
      >
        Готово
      </button>
      <button
        onClick={onGiveUp}
        className="text-[12px] text-app-hint underline underline-offset-4 decoration-app-hint/50 active:opacity-60"
      >
        Не знаю — показать ответ
      </button>
    </>
  )
}

function SpeedChip({ speed, onCycle }: { speed: TtsSpeed; onCycle: () => void }) {
  return (
    <button
      onClick={onCycle}
      className="text-[10px] uppercase tracking-widest font-bold px-3 py-1 rounded-full border border-app-border text-app-hint active:bg-app-surface active:scale-95 transition-all"
      aria-label="Скорость произношения"
    >
      {labelForSpeed(speed)}
    </button>
  )
}

function RatingButton({ label, sub, bg, color, onClick }: { label: string; sub: string; bg: string; color: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex flex-col items-center justify-center gap-0.5 rounded-2xl active:scale-95 transition-transform ${bg}`}
    >
      <span className={`text-[13px] font-bold ${color}`}>{label}</span>
      <span className={`text-[10px] font-medium opacity-60 uppercase ${color}`}>{sub}</span>
    </button>
  );
}

function ClozeFeedback({ result, typedAnswer }: { result: MatchResult; typedAnswer: string }) {
  if (result.kind === 'exact') {
    return (
      <span className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-widest">
        ✓ Точно
      </span>
    )
  }
  if (result.kind === 'close') {
    return (
      <div className="flex flex-col items-center gap-1.5">
        <span className="bg-amber-500/15 text-amber-600 dark:text-amber-400 px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-widest">
          ≈ Близко
        </span>
        <span className="text-xs text-app-hint">ты написал: {typedAnswer.trim() || '—'}</span>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center gap-1.5">
      <span className="bg-rose-500/15 text-rose-600 dark:text-rose-400 px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-widest">
        ✗ Не то
      </span>
      {typedAnswer.trim() && (
        <span className="text-xs text-app-hint">ты написал: {typedAnswer.trim()}</span>
      )}
    </div>
  )
}

/**
 * Returns the term substring as it appears in `context_sentence`, falling
 * back to `payload.term` if the offsets are invalid (e.g. legacy cards
 * ingested with zero offsets). Matching uses this so casual inflections
 * stored in the sentence pass exact-match.
 */
function extractClozeTerm(vocab: VocabPayload): string {
  const start = vocab.context_term_start
  const end = vocab.context_term_end
  if (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end > start &&
    end <= vocab.context_sentence.length
  ) {
    return vocab.context_sentence.slice(start, end)
  }
  return vocab.term
}

function buildClozeSentence(vocab: VocabPayload): { before: string; after: string; targetLength: number } | null {
  const start = vocab.context_term_start
  const end = vocab.context_term_end
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    end > vocab.context_sentence.length
  ) {
    // Offsets unusable — fall back to "term-shaped blank" pattern, since the
    // backend may not have populated them precisely.
    return {
      before: vocab.context_sentence + ' (',
      after: ' = ?)',
      targetLength: vocab.term.length,
    }
  }
  return {
    before: vocab.context_sentence.slice(0, start),
    after: vocab.context_sentence.slice(end),
    targetLength: end - start,
  }
}
