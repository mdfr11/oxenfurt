import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { motion, AnimatePresence, type PanInfo } from 'framer-motion';
import { Coffee, X, Info, Mic, MicOff, Pencil } from 'lucide-react';
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
import { Markdown } from './Markdown';
import { getSettings } from '../lib/settings';
import { isSpeechRecognitionSupported, startRecognition, type RecognitionHandle } from '../lib/speechRecognition';
import { EditCardSheet } from './EditCardSheet';

interface PracticeSessionProps {
  mode: PracticeMode;
  onComplete: (total: number, correct: number) => void;
  onExit: () => void;
}

function safeHaptic(method: 'impactOccurred' | 'notificationOccurred' | 'selectionChanged', ...args: any[]): void {
  try {
    const { hapticsEnabled } = getSettings();
    if (!hapticsEnabled) return;

    if (method === 'impactOccurred') {
      hapticFeedback.impactOccurred(args[0]);
    } else if (method === 'notificationOccurred') {
      hapticFeedback.notificationOccurred(args[0]);
    } else if (method === 'selectionChanged') {
      hapticFeedback.selectionChanged();
    }
  } catch (e) {
    // SDK not initialised (dev outside Telegram) — silently ignore
  }
}

export function PracticeSession({ mode, onComplete, onExit }: PracticeSessionProps) {
  // Prevent double-exit or lingering handlers during transition
  const [isExiting, setIsExiting] = useState(false);
  const [isSrsHelpOpen, setIsSrsHelpOpen] = useState(false);

  const handleExit = useMemo(() => () => {
    if (isExiting) return;
    setIsExiting(true);
    onExit();
  }, [isExiting, onExit]);

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
  const [translationTooltip, setTranslationTooltip] = useState<{ text: string; translation: string | null; x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Undo functionality state. `replaySpliceIndex` is set when a card was
  // re-queued after an Again rating, so undo can also remove the splice.
  const [pendingReview, setPendingReview] = useState<{
    id: string;
    rating: Rating;
    timeoutId: number;
    previousIndex: number;
    previousStats: typeof sessionStats;
    replaySpliceIndex: number | null;
  } | null>(null);

  // Working queue. Starts as the filtered `data.cards` and grows whenever
  // the user rates Again — the failed card gets spliced back in a few
  // positions ahead for in-session retry (Anki "learning steps" style).
  const [queue, setQueue] = useState<DueCardDto[]>([]);
  const [queueSeed, setQueueSeed] = useState<readonly DueCardDto[] | null>(null);

  const [isEditOpen, setIsEditOpen] = useState(false);

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
        stopSpeaking()
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
        if (isExiting) return;
        try {
          const result = await popup.open({
            title: 'Завершить сессию?',
            message: 'Прогресс сохранён. Можно вернуться позже.',
            buttons: [
              { id: 'stay', type: 'cancel' },
              { id: 'leave', type: 'destructive', text: 'Выйти' },
            ],
          })
          if (result === 'leave') handleExit()
        } catch {
          // popup unavailable — exit immediately
          handleExit()
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
  }, [handleExit, isExiting])

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

  // Typed-answer modes (cloze/translation/listening) have no sensible
  // rendering for theory cards — they have no `term` to gap-fill, translate,
  // or pronounce. Filter them out so the session stays coherent with the
  // user's chosen mode. They remain available in `recognition` and `mixed`.
  const baseCards = useMemo<DueCardDto[]>(() => {
    const all = data?.cards ?? [];
    if (mode === 'cloze' || mode === 'translation' || mode === 'listening') {
      return all.filter((c) => c.type !== 'theory');
    }
    return all;
  }, [data?.cards, mode]);

  // Re-seed working queue whenever the underlying due list changes
  // (refetch, mode switch, bypass toggle). React 19 idiomatic — set state
  // during render, identity-compare against the previous seed.
  if (queueSeed !== baseCards) {
    setQueueSeed(baseCards);
    setQueue(baseCards);
    if (currentIndex !== 0) setCurrentIndex(0);
  }

  const currentCard = queue[currentIndex];
  const progress = queue.length > 0 ? (currentIndex / queue.length) * 100 : 0;

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

  // Produce-direction flip. Only applies to vocab cards in the recognition
  // variant — there we swap front (term + audio) with back (translation).
  // The other variants already test production in their own way (translation
  // mode is already RU → EN typed; cloze fills the gap; listening is sound-
  // first regardless of direction). Read once per session — toggling mid-
  // practice is rare and not worth subscribing for.
  const produceMode = useMemo(() => getSettings().produceDirection, [])
  const flipForProduce =
    produceMode && variant === 'recognition' && currentCard?.type === 'vocab'

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

  // Listening variant or Auto-pronounce setting: pronounce the term on card show.
  // Suppressed when produce-mode flips the card — the term is the answer
  // there, so speaking it on the front would spoil the prompt.
  useEffect(() => {
    const { autoPronounce } = getSettings();
    const shouldSpeak =
      (variant === 'listening' || autoPronounce) &&
      !isRevealed &&
      !flipForProduce &&
      currentCard?.type === 'vocab';

    if (shouldSpeak) {
      const vocab = currentCard.payload as VocabPayload
      // Small delay so the card animation finishes before audio starts.
      const t = setTimeout(() => { void speak(vocab.term, { rate: rateForSpeed(ttsSpeed) }) }, 250)
      return () => {
        clearTimeout(t)
        stopSpeaking()
      }
    }
    return undefined
  }, [currentCard?.id, variant, isRevealed, currentCard, ttsSpeed, flipForProduce])

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

    // Auto-replay: on Again, re-queue this card a few positions ahead so the
    // user sees it again in the same session (Anki learning-steps style).
    // The FSRS review still fires normally — the server treats each retry
    // as an independent rating event.
    let replaySpliceIndex: number | null = null;
    let workingLength = queue.length;
    if (rating === RATING.Again) {
      replaySpliceIndex = Math.min(currentIndex + 4, queue.length);
      workingLength = queue.length + 1;
      setQueue((q) => {
        const pos = Math.min(currentIndex + 4, q.length);
        return [...q.slice(0, pos), currentCard, ...q.slice(pos)];
      });
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
      replaySpliceIndex,
    });

    setSessionStats(nextStats)

    // Optimistically advance
    if (currentIndex < workingLength - 1) {
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
    
    // If the previous Again spliced the card into the queue, also remove
    // that splice so the future-position state is consistent with the undo.
    if (pendingReview.replaySpliceIndex !== null) {
      const pos = pendingReview.replaySpliceIndex;
      setQueue((q) => [...q.slice(0, pos), ...q.slice(pos + 1)]);
    }

    // Revert state
    setCurrentIndex(pendingReview.previousIndex);
    setSessionStats(pendingReview.previousStats);
    setIsRevealed(true);
    setPendingReview(null);
    safeHaptic('selectionChanged');
  };

  const handleWordTap = async (word: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const cleanWord = word.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"").trim();
    if (!cleanWord || cleanWord.length < 2) return;

    // Show loading state immediately
    setTranslationTooltip({
      text: cleanWord,
      translation: null,
      x: e.clientX,
      y: e.clientY
    });

    try {
      const res = await fetchWithAuth(`/translate?text=${encodeURIComponent(cleanWord)}`);
      if (res.ok) {
        const { translation } = await res.json();
        setTranslationTooltip(prev => prev ? { ...prev, translation } : null);
      }
    } catch (err) {
      setTranslationTooltip(null);
    }
  };

  useEffect(() => {
    const hideTooltip = () => setTranslationTooltip(null);
    if (translationTooltip) {
      window.addEventListener('click', hideTooltip);
      return () => window.removeEventListener('click', hideTooltip);
    }
  }, [translationTooltip]);
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
          onClick={handleExit}
          className="w-full bg-app-primary text-app-primary-text py-4 rounded-2xl font-semibold text-lg active:scale-95 transition-transform shadow-lg shadow-app-primary/20"
        >
          На главную
        </button>
      </div>
    );
  }

  if (queue.length === 0) {
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
            onClick={handleExit}
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

  // Split sentence logic for target term highlighting and contextual translation
  const renderSentenceWithHighlight = (sentence: string, term: string) => {
    const fontSize = sentence.length > 120 ? 'text-lg' : sentence.length > 70 ? 'text-xl' : 'text-2xl';
    
    // First, split by the main term to preserve its highlighting
    const parts = sentence.split(new RegExp(`(${term})`, 'gi'));
    
    return (
      <p className={`${fontSize} leading-relaxed italic font-serif`}>
        {parts.map((part, i) => {
          if (part.toLowerCase() === term.toLowerCase()) {
            return <span key={i} className="text-app-primary font-bold underline decoration-2 underline-offset-4">{part}</span>;
          }
          
          // Split non-term parts into words for tap-to-translate
          return (
            <span key={i}>
              {part.split(/(\s+)/).map((word, wi) => (
                <span 
                  key={wi} 
                  className={word.trim().length > 1 ? 'cursor-help active:text-app-primary transition-colors' : ''}
                  onClick={(e) => word.trim().length > 1 && handleWordTap(word, e)}
                >
                  {word}
                </span>
              ))}
            </span>
          );
        })}
      </p>
    );
  };

  return (
    <div className="flex-1 flex flex-col bg-app-bg text-app-text overflow-hidden">
      {/* Progress Bar */}
      <div className="h-1 w-full bg-black/5 dark:bg-white/5 relative">
        <motion.div
          className="h-full bg-app-primary"
          initial={{ width: 0 }}
          animate={{ width: `${progress}%` }}
        />
        {/* Hourglass Timer - subtle 2px line at the top of the card area */}
        {!isRevealed && !isExiting && (
           <motion.div 
             key={`timer-${currentCard.id}`}
             initial={{ width: 0 }}
             animate={{ width: '100%' }}
             transition={{ duration: 15, ease: 'linear' }}
             className="absolute top-0 left-0 h-[2px] bg-orange-400/40 z-30"
           />
        )}
      </div>

      <div className="p-4 flex justify-between items-center text-[10px] text-app-hint uppercase tracking-wider font-bold">
        <span>Карточка {currentIndex + 1} / {queue.length}</span>
        <div className="flex items-center gap-3">
          {currentCard!.type === 'theory' && <span className="text-app-primary">📖 Theory</span>}
          <button
            onClick={handleExit}
            className="w-7 h-7 flex items-center justify-center rounded-full bg-black/5 dark:bg-white/10 text-app-hint active:scale-95 transition-transform"
            aria-label="Завершить сессию"
          >
            <X size={16} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      <div className="flex-1 px-4 flex items-center justify-center relative min-h-0">
        <AnimatePresence mode="popLayout">
          <motion.div
            key={currentCard.id}
            initial={{ opacity: 0, x: 50, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: -50, scale: 0.9, pointerEvents: 'none' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
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
            className={`w-full aspect-[3/4] bg-app-surface rounded-[2.5rem] relative border border-app-border shadow-xl overflow-hidden ${
              expectsTypedAnswer ? '' : 'cursor-pointer'
            } ${isRevealed ? 'cursor-grab active:cursor-grabbing' : ''}`}
            whileTap={expectsTypedAnswer ? undefined : { scale: 0.98 }}
          >
            <AnimatePresence initial={false}>
              {!isRevealed ? (
                <motion.div
                  key="front"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 1.05 }}
                  transition={{ duration: 0.2 }}
                  className="absolute inset-0 p-8 flex flex-col items-center justify-center gap-6"
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
                      <div onClick={(e) => e.stopPropagation()}>
                        <SpeedChip speed={ttsSpeed} onCycle={cycleSpeed} />
                      </div>
                      <p className="text-[11px] text-app-hint mt-2">Тап чтобы повторить</p>
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
                  ) : vocab && flipForProduce ? (
                    <>
                      <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold">Скажи по-английски</div>
                      <h2 className="text-3xl font-bold tracking-tight text-app-text leading-snug text-center">
                        {vocab.translation}
                      </h2>
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
                    <div className="overflow-y-auto max-h-full w-full px-2 text-center">
                      <Markdown className="text-xl font-bold leading-snug">
                        {theory.question}
                      </Markdown>
                    </div>
                  ) : null}
                  
                  {!expectsTypedAnswer && (
                    <div className="absolute top-4 left-6 pointer-events-none">
                      <CardStabilityIndicator stability={currentCard!.fsrs.stability} />
                    </div>
                  )}

                  {currentCard!.source && !expectsTypedAnswer && (
                    <div className="absolute inset-x-0 bottom-10 text-[10px] text-app-hint uppercase tracking-[0.2em] font-bold opacity-40 pointer-events-none text-center">
                      {currentCard!.source}
                    </div>
                  )}

                  {!expectsTypedAnswer && (
                    <div className="absolute inset-x-0 bottom-4 text-[9px] text-app-hint opacity-30 uppercase font-bold tracking-[0.3em] pointer-events-none text-center">
                      Тап чтобы открыть
                    </div>
                  )}
                </motion.div>
              ) : (
                <motion.div
                  key="back"
                  initial={{ opacity: 0, scale: 1.05 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.2 }}
                  className="absolute inset-0 p-8 flex flex-col items-center justify-center gap-5"
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setIsEditOpen(true)
                    }}
                    className="absolute top-4 right-4 w-8 h-8 rounded-full bg-app-surface text-app-hint border border-app-border flex items-center justify-center active:scale-90 transition-transform"
                    aria-label="Редактировать карточку"
                  >
                    <Pencil size={14} />
                  </button>
                  {matchResult && expectsTypedAnswer && (
                    <ClozeFeedback result={matchResult} typedAnswer={typedAnswer} />
                  )}
                  {vocab && flipForProduce ? (
                    <>
                      <div className="flex items-center gap-3">
                        <h2 className="text-4xl font-bold tracking-tight">
                          {vocab.term}
                        </h2>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
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
                      <span className="bg-app-primary/10 text-app-primary px-4 py-1 rounded-full text-xs font-bold uppercase tracking-widest">
                        {vocab.translation}
                      </span>
                      {renderSentenceWithHighlight(vocab.context_sentence, vocab.term)}
                    </>
                  ) : vocab ? (
                    <>
                      <span className="bg-app-primary/10 text-app-primary px-4 py-1 rounded-full text-xs font-bold uppercase tracking-widest">
                        {vocab.translation}
                      </span>
                      {renderSentenceWithHighlight(vocab.context_sentence, vocab.term)}
                    </>
                  ) : theory ? (
                    <div className="overflow-y-auto max-h-full w-full px-1">
                      <Markdown className="text-base leading-relaxed text-left">
                        {theory.answer}
                      </Markdown>
                      {currentCard!.source_quote && (
                        <div className="mt-4 pt-3 border-t border-app-border">
                          <p className="text-[10px] uppercase tracking-widest text-app-hint font-bold mb-1">
                            Из урока
                          </p>
                          <Markdown
                            className="text-sm text-app-hint italic leading-relaxed"
                            inline
                          >
                            {`«${currentCard!.source_quote}»`}
                          </Markdown>
                        </div>
                      )}
                    </div>
                  ) : null}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </AnimatePresence>
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
        <div className="flex items-center justify-center gap-1.5 pb-2 px-3">
          <p className="text-[10px] text-app-hint uppercase tracking-widest font-bold">
            Как легко вспомнил? · тап = далее
          </p>
          <button 
            onClick={() => setIsSrsHelpOpen(true)}
            className="text-app-hint active:text-app-primary transition-colors"
            aria-label="Что значат числа?"
          >
            <Info size={14} />
          </button>
        </div>
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
      
      <SrsHelpSheet isOpen={isSrsHelpOpen} onClose={() => setIsSrsHelpOpen(false)} />

      <EditCardSheet
        card={currentCard ?? null}
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        onSaved={(updated) => {
          // Patch the working queue in place so the user sees the edit
          // immediately on the back they're already looking at.
          setQueue((q) => q.map((c) => (c.id === updated.id ? updated : c)))
        }}
      />

      {/* Contextual Translation Tooltip */}
      <AnimatePresence>
        {translationTooltip && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 10 }}
            className="fixed z-[100] px-4 py-2 bg-zinc-900 text-white rounded-xl shadow-xl border border-white/10 flex flex-col items-center text-center gap-0.5"
            style={{ 
              left: Math.max(16, Math.min(window.innerWidth - 150, translationTooltip.x - 75)),
              top: translationTooltip.y - 80 
            }}
          >
            <div className="text-[10px] uppercase font-bold text-white/50 tracking-widest">{translationTooltip.text}</div>
            <div className="text-sm font-semibold">
              {translationTooltip.translation || '...'}
            </div>
            {/* Tooltip arrow */}
            <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-zinc-900 rotate-45 border-r border-b border-white/10" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SrsHelpSheet({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/40 z-50"
          />
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
            className="fixed bottom-0 inset-x-0 bg-app-bg rounded-t-3xl p-6 z-[60] shadow-[0_-10px_40px_rgba(0,0,0,0.1)] flex flex-col max-w-[500px] mx-auto text-app-text"
          >
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold flex items-center gap-2">
                <Info size={20} className="text-app-primary" /> Оценки и интервалы
              </h2>
              <button onClick={onClose} className="p-2 -mr-2 text-app-hint active:scale-95 transition-transform">
                <X size={20} />
              </button>
            </div>

            <div className="space-y-4 text-sm leading-relaxed">
              <p>
                Числа под кнопками (например, <span className="font-bold text-app-primary">10м</span> или <span className="font-bold text-app-primary">4д</span>) — это время, через которое карточка появится снова.
              </p>
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-3 bg-app-surface border border-app-border p-4 rounded-2xl">
                <span className="font-bold text-rose-600 dark:text-rose-400">Снова</span>
                <span>Ты не вспомнил слово. Оно вернется очень скоро, чтобы закрепить его в памяти.</span>
                
                <span className="font-bold text-orange-600 dark:text-orange-400">Трудно</span>
                <span>Вспомнил с большим трудом. Интервал увеличится лишь немного.</span>
                
                <span className="font-bold text-blue-600 dark:text-blue-400">Хорошо</span>
                <span>Вспомнил после небольшой паузы. Идеальный баланс для обучения.</span>
                
                <span className="font-bold text-emerald-600 dark:text-emerald-400">Легко</span>
                <span>Вспомнил мгновенно. Слово отправится в долгий ящик — интервал вырастет максимально.</span>
              </div>
              <p className="text-app-hint text-xs italic mt-2">
                Алгоритм FSRS подбирает эти интервалы индивидуально для каждой карточки, чтобы ты тратил минимум времени на повторение.
              </p>
            </div>
            
            <button 
              onClick={onClose}
              className="w-full bg-app-primary text-app-primary-text py-4 rounded-2xl font-bold mt-6 active:scale-95 transition-transform shadow-lg shadow-app-primary/20"
            >
              Понятно
            </button>

            <div style={{ height: 'calc(1rem + var(--tg-safe-area-inset-bottom, 0px))' }}></div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
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

  const [isListening, setIsListening] = useState(false);
  const [voiceUnavailable, setVoiceUnavailable] = useState(false);
  const [voiceHint, setVoiceHint] = useState<string | null>(null);
  const recognitionRef = useRef<RecognitionHandle | null>(null);
  const speechSupported = isSpeechRecognitionSupported();

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
    };
  }, []);

  const toggleVoice = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isListening) {
      recognitionRef.current?.stop();
      return;
    }
    setVoiceHint(null);
    const handle = startRecognition({
      lang: 'en-US',
      onInterim: (interim) => onChange(interim),
      onResult: (transcript) => {
        onChange(transcript);
        setVoiceHint(null);
      },
      onError: (code) => {
        // Map raw codes to user-readable hints. `not-allowed` / `service-
        // not-allowed` mean mic permission denied at OS or browser level —
        // hide the mic since retrying won't help. Others are transient
        // (network, no-speech, no-audio, no-match) — show a hint and let
        // the user try again.
        if (code === 'not-allowed' || code === 'service-not-allowed') {
          setVoiceUnavailable(true);
          setVoiceHint('Микрофон запрещён. Проверь разрешения Telegram → Микрофон в настройках телефона.');
        } else if (code === 'network') {
          setVoiceHint('Нет связи с сервисом распознавания. Проверь интернет.');
        } else if (code === 'no-audio') {
          setVoiceHint('Микрофон не передал звук. В Telegram WebView это бывает — попробуй открыть приложение через 🌐 в браузере.');
        } else if (code === 'no-speech' || code === 'no-match') {
          setVoiceHint('Ничего не услышал. Говори ближе к микрофону.');
        } else {
          setVoiceHint('Не получилось: ' + code);
        }
      },
      onEnd: () => {
        setIsListening(false);
        recognitionRef.current = null;
      },
    });
    if (handle === null) {
      setVoiceUnavailable(true);
      setVoiceHint('Голосовой ввод недоступен в этом браузере.');
      return;
    }
    recognitionRef.current = handle;
    setIsListening(true);
  };

  const showMic = speechSupported && !voiceUnavailable;

  return (
    <>
      <div className="w-full max-w-[240px] relative">
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
          className={`w-full text-center text-lg bg-app-bg border rounded-xl py-3 ${showMic ? 'pl-4 pr-12' : 'px-4'} focus:outline-none transition-colors ${
            isError ? 'border-rose-500 bg-rose-500/5' :
            isSuccess ? 'border-emerald-500 bg-emerald-500/5' :
            isListening ? 'border-app-primary bg-app-primary/5' :
            'border-app-border focus:border-app-primary'
          }`}
        />
        {showMic && (
          <motion.button
            type="button"
            onClick={toggleVoice}
            animate={isListening ? { scale: [1, 1.15, 1] } : { scale: 1 }}
            transition={isListening ? { duration: 1, repeat: Infinity } : { duration: 0.2 }}
            className={`absolute right-1.5 top-1/2 -translate-y-1/2 w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
              isListening
                ? 'bg-rose-500/15 text-rose-500'
                : 'bg-app-surface text-app-hint active:scale-95'
            }`}
            aria-label={isListening ? 'Остановить запись' : 'Сказать голосом'}
          >
            {isListening ? <MicOff size={16} /> : <Mic size={16} />}
          </motion.button>
        )}
      </div>
      {voiceHint && (
        <p className="w-full max-w-[280px] text-[11px] text-app-hint text-center leading-snug -mt-2">
          {voiceHint}
        </p>
      )}
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

function CardStabilityIndicator({ stability }: { stability: number }) {
  // 5 steps of stability
  let activeDots = 1;
  if (stability > 90) activeDots = 5;
  else if (stability > 30) activeDots = 4;
  else if (stability > 10) activeDots = 3;
  else if (stability > 2) activeDots = 2;

  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((i) => (
        <div 
          key={i} 
          className={`h-1 w-3 rounded-full transition-colors ${i <= activeDots ? 'bg-app-primary/60' : 'bg-app-hint/15'}`}
        />
      ))}
    </div>
  );
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
