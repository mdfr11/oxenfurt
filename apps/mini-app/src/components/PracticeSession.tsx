import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { motion, AnimatePresence, useMotionValue, useTransform, type PanInfo } from 'framer-motion';
import { Coffee, X, Info, Pencil, Type, Quote, BookOpen, Layers, HelpCircle, Volume2 } from 'lucide-react';
import {
  backButton,
  disableVerticalSwipes,
  enableVerticalSwipes,
  popup,
} from '@telegram-apps/sdk-react';
import { haptic } from '../lib/telegram';
import {
  RATING,
  matchAnswer,
  type DueCardDto,
  type MatchResult,
  type PhrasePayload,
  type Rating,
  type TheoryPayload,
  type VocabPayload,
} from '@oxenfurt/shared';
import { fetchWithAuth } from '../lib/api';
import { formatInterval, previewIntervals } from '../lib/fsrs';
import { playPopSound, playSuccessChime, playThudSound } from '../lib/audio';
import { pickVariantFor, type PracticeMode, type ExerciseVariant } from '../lib/practiceMode';
import {
  buildClozeSentence,
  buildPhraseCloze,
  extractClozeTerm,
} from './practiceHelpers';
import { stopSpeaking } from '../lib/tts';
import { useCardAudio } from '../hooks/useCardAudio';
import { Markdown } from './Markdown';
import { getSettings } from '../lib/settings';
import { loadSession } from '../lib/sessionPersist';
import { usePracticeQueue } from '../hooks/usePracticeQueue';
import { CardStabilityIndicator } from './practice/CardStabilityIndicator';
import { ClozeFeedback } from './practice/ClozeFeedback';
import { RatingButton } from './practice/RatingButton';
import { SpeedChip } from './practice/SpeedChip';
import { SrsHelpSheet } from './practice/SrsHelpSheet';
import { TypedAnswerField } from './practice/TypedAnswerField';
import { EditCardSheet } from './EditCardSheet';
import { RelatedCardsSheet } from './RelatedCardsSheet';
import { QuestionSheet } from './QuestionSheet';
import { useT } from '../lib/i18n/useT';

interface PracticeSessionProps {
  mode: PracticeMode;
  onComplete: (total: number, correct: number) => void;
  onExit: () => void;
}

export function PracticeSession({ mode, onComplete, onExit }: PracticeSessionProps) {
  const t = useT();
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

  // Soft cap from settings — null = no override, let backend default kick in.
  const sessionLimit = useMemo(() => getSettings().sessionLimit, [])

  // Snapshot of any paused session for THIS mode. Read once so the
  // /due query can decide whether to fetch fresh cards. The
  // usePracticeQueue hook also reads localStorage internally for its
  // own init — cheap, and avoids prop-drilling the snapshot in.
  const hasResumedSession = useMemo(() => loadSession(mode) !== null, [mode])

  // /due query — gated by the resumed-session check. Resumed sessions
  // hydrate the queue from localStorage in usePracticeQueue, so we skip
  // the fetch entirely. Fresh sessions issue a single request keyed by
  // (bypassDue, sessionLimit); background refetches are ignored by the
  // hook's shouldReseed guard.
  const { data, isLoading, error } = useQuery({
    queryKey: ['cards', 'due', bypassDue, sessionLimit],
    enabled: !hasResumedSession,
    queryFn: async () => {
      const params = new URLSearchParams()
      if (bypassDue) {
        params.set('bypass_due', 'true')
        params.set('limit', '50')
      }
      if (sessionLimit !== null) params.set('limit', String(sessionLimit))
      const qs = params.toString()
      const path = qs ? `/cards/due?${qs}` : '/cards/due'
      const res = await fetchWithAuth(path)
      if (!res.ok) throw new Error('Failed to fetch cards')
      return (await res.json()) as { cards: DueCardDto[] }
    },
  })

  const [isRevealed, setIsRevealed] = useState(false);
  // Cloze-only state — reset on each card via the effect below.
  const [typedAnswer, setTypedAnswer] = useState('');
  const [matchResult, setMatchResult] = useState<MatchResult | null>(null);
  const [translationTooltip, setTranslationTooltip] = useState<{ text: string; translation: string | null; x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Motion values for swipe feedback
  const dragX = useMotionValue(0);
  const dragY = useMotionValue(0);

  // useTransform with multiple inputs got stricter typing in framer-motion 11
  // — the legacy array-input overload no longer matches a plain `[x, y]`
  // destructure. Use the callback form, which reads .get() from each.
  const cardBackground = useTransform(() => {
    const x = dragX.get()
    const y = dragY.get()
    const threshold = 50;
    if (Math.abs(x) > Math.abs(y)) {
      if (x > threshold) return `rgba(59, 130, 246, ${Math.min(0.15, (x - threshold) / 400)})`; // Good - Blue
      if (x < -threshold) return `rgba(249, 115, 22, ${Math.min(0.15, (Math.abs(x) - threshold) / 400)})`; // Hard - Orange
    } else {
      if (y > threshold) return `rgba(244, 63, 94, ${Math.min(0.15, (y - threshold) / 400)})`; // Again - Rose
      if (y < -threshold) return `rgba(16, 185, 129, ${Math.min(0.15, (Math.abs(y) - threshold) / 400)})`; // Easy - Emerald
    }
    return 'rgba(255, 255, 255, 0)';
  });

  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isRelatedOpen, setIsRelatedOpen] = useState(false);
  const [isQuestionOpen, setIsQuestionOpen] = useState(false);

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
            title: t('practice.exit_title'),
            message: t('practice.exit_message'),
            buttons: [
              { id: 'stay', type: 'cancel' },
              { id: 'leave', type: 'destructive', text: t('practice.exit_leave') },
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

  // Queue + cursor + stats + pending-review undo slot + session-id ref
  // all live in this hook. See hooks/usePracticeQueue.ts for the why —
  // short version: the lock/unlock regression was a queue state-machine
  // bug, isolating the state makes it both easier to reason about and
  // easier to write regression tests for (see practiceHelpers.test.ts).
  const queueState = usePracticeQueue({ mode, baseCards })
  const {
    queue,
    currentIndex,
    sessionStats,
    currentCard,
    progress,
    pendingReview,
    setPendingReview,
  } = queueState

  // Mirror of pendingReview into a ref so the unmount cleanup below sees
  // the latest value without needing pendingReview in deps (which would
  // re-run the cleanup on every rating, double-flushing reviews).
  const pendingReviewRef = useRef(pendingReview)
  useEffect(() => {
    pendingReviewRef.current = pendingReview
  }, [pendingReview])

  // Flush any pending review on unmount — the undo timer is in-memory
  // only, so if the user exits before it fires we still want the rating
  // to land on the server.
  useEffect(() => {
    return () => {
      const pending = pendingReviewRef.current
      if (pending) {
        clearTimeout(pending.timeoutId);
        reviewMutation.mutate({ id: pending.id, rating: pending.rating });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  // The user taps the input themselves when ready. `inputRef` is forwarded
  // to TypedAnswerField below; it's not focused here on purpose.

  // TTS surface (auto-pronounce + speed control + manual replay) lives
  // in a dedicated hook so this file isn't the one place that decides
  // when to speak. Pure decisions (shouldAutoPronounce / pickSpeakable)
  // are in practiceHelpers.ts for direct unit testing.
  const { ttsSpeed, cycleSpeed, replay: handleReplayAudio } = useCardAudio({
    card: currentCard,
    variant,
    isRevealed,
    flipForProduce,
  })

  // (The screen-leave stopSpeaking() lives in the disableVerticalSwipes
  // cleanup effect above — keeping a second copy here would double-fire.)

  const handleReveal = () => {
    // Typed variants reveal via submit, not tap.
    if (expectsTypedAnswer) return
    // Recognition: tap toggles reveal — second tap flips back to the front.
    setIsRevealed((prev) => !prev)
    haptic('impactOccurred', 'light')
    playPopSound()
  };

  const handleAnswerSubmit = () => {
    if (isRevealed || !expectsTypedAnswer || !currentCard) return;
    let expected: string | null = null
    if (currentCard.type === 'vocab') {
      const vocabPayload = currentCard.payload as VocabPayload;
      expected = variant === 'cloze' ? extractClozeTerm(vocabPayload) : vocabPayload.term;
    } else if (currentCard.type === 'phrase') {
      const phrasePayload = currentCard.payload as PhrasePayload;
      if (variant === 'cloze') {
        // Cloze for phrases: user types only the blanked word. Consistent
        // with vocab cloze where you type just the missing term.
        const cloze = buildPhraseCloze(phrasePayload.phrase, currentCard.id);
        expected = cloze !== null ? cloze.blank : phrasePayload.phrase;
      } else {
        expected = phrasePayload.phrase;
      }
    }
    if (expected === null) return;
    const result = matchAnswer(typedAnswer, expected);
    setMatchResult(result);
    setIsRevealed(true);
    if (result.kind === 'exact') { haptic('notificationOccurred', 'success'); playPopSound(); }
    else if (result.kind === 'close') { haptic('impactOccurred', 'medium'); playPopSound(); }
    else { haptic('notificationOccurred', 'error'); playThudSound(); }
  };

  // "I don't know" / "show me the answer" — bypass fuzzy match entirely and
  // reveal the card. No match feedback chip is shown (the user wasn't testing
  // a guess), and the FSRS rating is still theirs to pick — they might want
  // Hard if they almost had it, or Again if they were clueless.
  const handleGiveUp = () => {
    if (isRevealed || !expectsTypedAnswer || !currentCard) return
    setMatchResult(null)
    setIsRevealed(true)
    haptic('impactOccurred', 'light')
    playThudSound()
  };

  const handleRate = (rating: Rating) => {
    if (!currentCard) return;

    if (rating === RATING.Again) { haptic('notificationOccurred', 'error'); playThudSound(); }
    else if (rating === RATING.Hard) { haptic('impactOccurred', 'medium'); playPopSound(); }
    else if (rating === RATING.Good) { haptic('selectionChanged'); playPopSound(); }
    else { haptic('notificationOccurred', 'success'); playPopSound(); }

    const isCorrect = rating !== RATING.Again;
    const correctDelta: 0 | 1 = isCorrect ? 1 : 0;
    const nextStats = {
      total: sessionStats.total + 1,
      correct: sessionStats.correct + correctDelta,
    }

    // Auto-replay: on Again, re-queue this card a few positions ahead so
    // the user sees it again in the same session (Anki learning-steps
    // style). Gated by a setting (default off).
    let replaySpliceIndex: number | null = null;
    let workingLength = queue.length;
    if (rating === RATING.Again && getSettings().inSessionReplay) {
      replaySpliceIndex = queueState.spliceAhead(currentCard);
      workingLength = queue.length + 1;
    }

    // Flush any existing pending review immediately before queueing the next one.
    if (pendingReview) {
      clearTimeout(pendingReview.timeoutId);
      reviewMutation.mutate({ id: pendingReview.id, rating: pendingReview.rating });
    }

    // Delay the API call by 3.5 seconds to allow undo.
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

    if (currentIndex < workingLength - 1) {
      // Optimistically advance to the next card.
      setIsRevealed(false);
      queueState.advance({ total: 1, correct: correctDelta });
    } else {
      // Last card: no undo, flush immediately and complete.
      clearTimeout(timeoutId);
      setPendingReview(null);
      reviewMutation.mutate({ id: currentCard.id, rating });

      haptic('notificationOccurred', 'success')
      playSuccessChime()
      queueState.finishBackendSession(nextStats.total, nextStats.correct)
      queueState.markFinished();
      onComplete(nextStats.total, nextStats.correct);
    }
  };

  // (Persist effect, session-id boot, and finish-API call all live in
  // usePracticeQueue now.)

  const handleUndo = () => {
    if (!pendingReview) return;
    clearTimeout(pendingReview.timeoutId);
    // If the previous Again spliced the card into the queue, also remove
    // that splice so the future-position state is consistent with undo.
    if (pendingReview.replaySpliceIndex !== null) {
      queueState.removeAt(pendingReview.replaySpliceIndex);
    }
    queueState.rollback(pendingReview.previousIndex, pendingReview.previousStats);
    setIsRevealed(true);
    setPendingReview(null);
    haptic('selectionChanged');
  };

  const handleWordTap = async (word: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const cleanWord = word.replace(/[.,/#!$%^&*;:{}=\-_`~()]/g,"").trim();
    if (!cleanWord || cleanWord.length < 2) return;

    // Show loading state immediately
    setTranslationTooltip({
      text: cleanWord,
      translation: null,
      x: e.clientX,
      y: e.clientY
    });

    try {
      const { learningLanguage, nativeLanguage } = getSettings()
      const params = new URLSearchParams({
        text: cleanWord,
        from: learningLanguage,
        to: nativeLanguage,
      })
      const res = await fetchWithAuth(`/translate?${params.toString()}`);
      if (res.ok) {
        const { translation } = await res.json();
        setTranslationTooltip(prev => prev ? { ...prev, translation } : null);
      }
    } catch {
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
        <h2 className="text-2xl font-bold mb-2">{t('practice.error_load_title')}</h2>
        <p className="text-app-hint mb-2 max-w-[260px] text-sm">
          {error instanceof Error ? error.message : String(error)}
        </p>
        <p className="text-app-hint mb-10 max-w-[260px] text-xs opacity-60">
          {t('practice.error_load_hint')}
        </p>
        <button
          onClick={handleExit}
          className="w-full bg-app-primary text-app-primary-text py-4 rounded-2xl font-semibold text-lg active:scale-95 transition-transform shadow-lg shadow-app-primary/20"
        >
          {t('practice.btn_to_home')}
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
          {bypassDue ? t('practice.empty_title_zero') : t('practice.empty_title_done')}
        </h2>
        <p className="text-app-hint mb-10 max-w-[260px]">
          {bypassDue ? t('practice.empty_hint_zero') : t('practice.empty_hint_done')}
        </p>
        <div className="flex flex-col gap-3 w-full">
          {!bypassDue && (
            <button
              onClick={() => {
                setBypassDue(true)
                queueState.resetQueue()
                setIsRevealed(false)
              }}
              className="w-full bg-app-primary text-app-primary-text py-4 rounded-2xl font-semibold text-lg active:scale-95 transition-transform shadow-lg shadow-app-primary/20"
            >
              {t('practice.empty_btn_bypass')}
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
            {t('practice.empty_btn_home')}
          </button>
        </div>
      </div>
    );
  }

  // Past the queue.length=0 guard above, currentCard *should* be set —
  // but if we're past the last card (currentIndex >= queue.length) it
  // can still be undefined for a tick before onComplete fires. Render
  // nothing rather than letting the !-assertions explode below.
  if (!currentCard) return null

  const vocab = currentCard.type === 'vocab' ? (currentCard.payload as VocabPayload) : null;
  const theory = currentCard.type === 'theory' ? (currentCard.payload as TheoryPayload) : null;
  const phrase = currentCard.type === 'phrase' ? (currentCard.payload as PhrasePayload) : null;

  // Sentence with the target term replaced by an underline blank — used as
  // the cloze prompt. Falls back gracefully if the offsets look bogus.
  const clozePrompt = vocab && variant === 'cloze' ? buildClozeSentence(vocab) : null;
  const phraseCloze = phrase && variant === 'cloze' ? buildPhraseCloze(phrase.phrase, currentCard.id) : null;

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
                  className={word.trim().length > 1 ? 'cursor-help active:text-app-primary transition-colors decoration-app-primary/30 underline underline-offset-4 decoration-dotted' : ''}
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
      <div className="h-1 w-full bg-black/5 dark:bg-white/5">
        <motion.div
          className="h-full bg-app-primary"
          initial={{ width: 0 }}
          animate={{ width: `${progress}%` }}
        />
      </div>

      <div className="p-4 flex justify-between items-center text-[10px] text-app-hint uppercase tracking-wider font-bold">
        <span>{t('practice.card_n_of_m', { current: currentIndex + 1, total: queue.length })}</span>
        <div className="flex items-center gap-3">
          {currentCard!.type === 'vocab' && (
            <span className="text-app-primary flex items-center gap-1">
              <Type size={12} strokeWidth={2.5} /> {t('practice.word_badge')}
            </span>
          )}
          {currentCard!.type === 'phrase' && (
            <span className="text-app-primary flex items-center gap-1">
              <Quote size={12} strokeWidth={2.5} /> {t('practice.phrase_badge_short')}
            </span>
          )}
          {currentCard!.type === 'theory' && (
            <span className="text-app-primary flex items-center gap-1">
              <BookOpen size={12} strokeWidth={2.5} /> {t('practice.theory_badge_short')}
            </span>
          )}
          <button
            onClick={handleExit}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-app-surface border border-app-border text-app-hint shadow-sm active:scale-95 transition-transform"
            aria-label={t('practice.exit_button')}
          >
            <X size={16} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      <div className="flex-1 px-4 flex items-center justify-center relative min-h-0">
        <AnimatePresence mode="popLayout">
          <motion.div
            key={currentCard.id}
            style={{ x: dragX, y: dragY }}
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
              // Reset motion values after drag
              dragX.set(0);
              dragY.set(0);
            }}
            className={`w-full aspect-[3/4] bg-app-surface rounded-[2.5rem] relative border border-app-border shadow-xl overflow-hidden ${
              expectsTypedAnswer ? '' : 'cursor-pointer'
            } ${isRevealed ? 'cursor-grab active:cursor-grabbing' : ''}`}
            whileTap={expectsTypedAnswer ? undefined : { scale: 0.98 }}
            data-testid="card-ready"
          >
            {/* Swipe Feedback Overlay */}
            <motion.div 
              style={{ backgroundColor: cardBackground }}
              className="absolute inset-0 pointer-events-none z-10"
            />

            {/* Hourglass Timer - subtle line inside the card top */}
            {!isRevealed && !isExiting && (
               <motion.div 
                 key={`timer-${currentCard.id}`}
                 initial={{ width: 0 }}
                 animate={{ width: '100%' }}
                 transition={{ duration: 15, ease: 'linear' }}
                 className="absolute top-0 left-0 h-1 bg-orange-500/20 z-20"
               />
            )}
            
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
                        placeholder={t('practice.placeholder_cloze')}
                        matchResult={matchResult}
                      />
                    </>
                  ) : variant === 'cloze' && phrase && phraseCloze ? (
                    <>
                      <div data-testid="card-term" className="text-[10px] uppercase tracking-widest text-app-hint font-bold">{t('practice.prompt_fill_phrase')}</div>
                      <p className="text-2xl text-app-text leading-snug font-semibold text-center">
                        {phraseCloze.before}
                        {phraseCloze.before && ' '}
                        <span className="text-app-primary">{'_'.repeat(Math.max(3, Math.min(12, phraseCloze.blank.length)))}</span>
                        {phraseCloze.after && ' '}
                        {phraseCloze.after}
                      </p>
                      <p className="text-sm text-app-hint italic leading-relaxed text-center">
                        {phrase.translation}
                      </p>
                      <TypedAnswerField
                        inputRef={inputRef}
                        value={typedAnswer}
                        onChange={setTypedAnswer}
                        onSubmit={handleAnswerSubmit}
                        onGiveUp={handleGiveUp}
                        placeholder={t('practice.placeholder_cloze')}
                        matchResult={matchResult}
                      />
                    </>
                  ) : variant === 'translation' && phrase ? (
                    <>
                      <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold">{t('practice.prompt_translate_to', { lang: t(`lang.${getSettings().learningLanguage}_short`) })}</div>
                      <h2 className="text-xl font-bold leading-snug text-center">{phrase.translation}</h2>
                      <TypedAnswerField
                        inputRef={inputRef}
                        value={typedAnswer}
                        onChange={setTypedAnswer}
                        onSubmit={handleAnswerSubmit}
                        onGiveUp={handleGiveUp}
                        placeholder={t('practice.placeholder_typed', { lang: t(`lang.${getSettings().learningLanguage}_short`) })}
                        matchResult={matchResult}
                      />
                    </>
                  ) : variant === 'listening' && phrase ? (
                    <>
                      <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold">{t('practice.prompt_listen_phrase')}</div>
                      <button
                        onClick={handleReplayAudio}
                        className="w-20 h-20 rounded-full bg-app-primary/10 border border-app-primary/30 flex items-center justify-center text-3xl active:scale-95 transition-transform"
                        aria-label={t('practice.tap_to_replay')}
                      >
                          <Volume2 size={32} strokeWidth={2} className="text-app-primary" />
                      </button>
                      <div onClick={(e) => e.stopPropagation()}>
                        <SpeedChip speed={ttsSpeed} onCycle={cycleSpeed} />
                      </div>
                      <p className="text-[11px] text-app-hint mt-2">{t('practice.tap_to_replay')}</p>
                      <TypedAnswerField
                        inputRef={inputRef}
                        value={typedAnswer}
                        onChange={setTypedAnswer}
                        onSubmit={handleAnswerSubmit}
                        onGiveUp={handleGiveUp}
                        placeholder={t('practice.placeholder_listening')}
                        matchResult={matchResult}
                      />
                    </>
                  ) : variant === 'translation' && vocab ? (
                    <>
                      <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold">{t('practice.prompt_translation')}</div>
                      <h2 className="text-2xl font-bold leading-snug">{vocab.translation}</h2>
                      <TypedAnswerField
                        inputRef={inputRef}
                        value={typedAnswer}
                        onChange={setTypedAnswer}
                        onSubmit={handleAnswerSubmit}
                        onGiveUp={handleGiveUp}
                        placeholder={t('practice.placeholder_typed', { lang: t(`lang.${getSettings().learningLanguage}_short`) })}
                        matchResult={matchResult}
                      />
                    </>
                  ) : variant === 'listening' && vocab ? (
                    <>
                      <div data-testid="card-term" className="text-[10px] uppercase tracking-widest text-app-hint font-bold">{t('practice.prompt_listen')}</div>
                      <button
                        onClick={handleReplayAudio}
                        className="w-20 h-20 rounded-full bg-app-primary/10 border border-app-primary/30 flex items-center justify-center text-3xl active:scale-95 transition-transform"
                        aria-label={t('practice.tap_to_replay')}
                      >
                          <Volume2 size={32} strokeWidth={2} className="text-app-primary" />
                      </button>
                      <div onClick={(e) => e.stopPropagation()}>
                        <SpeedChip speed={ttsSpeed} onCycle={cycleSpeed} />
                      </div>
                      <p className="text-[11px] text-app-hint mt-2">{t('practice.tap_to_replay')}</p>
                      <TypedAnswerField
                        inputRef={inputRef}
                        value={typedAnswer}
                        onChange={setTypedAnswer}
                        onSubmit={handleAnswerSubmit}
                        onGiveUp={handleGiveUp}
                        placeholder={t('practice.placeholder_listening')}
                        matchResult={matchResult}
                      />
                    </>
                  ) : vocab && flipForProduce ? (
                    <>
                      <div data-testid="card-term" className="text-[10px] uppercase tracking-widest text-app-hint font-bold">{t('practice.prompt_produce_label', { lang: t(`lang.${getSettings().learningLanguage}_short`) })}</div>
                      <h2 className="text-3xl font-bold tracking-tight text-app-text leading-snug text-center">
                        {vocab.translation}
                      </h2>
                    </>
                  ) : vocab ? (
                    <>
                      <div className="flex items-center gap-3">
                        <h2 data-testid="card-term" className="text-4xl font-bold tracking-tight">
                          {vocab.term}
                        </h2>
                        <button
                          onClick={(e) => {
                            e.stopPropagation() // don't trigger card-level handleReveal
                            handleReplayAudio()
                          }}
                          className="w-10 h-10 rounded-full bg-app-primary/10 border border-app-primary/30 flex items-center justify-center text-base active:scale-90 transition-transform"
                          aria-label={t('practice.tap_to_replay')}
                        >
                          <Volume2 size={20} strokeWidth={2.5} className="text-app-primary" />
                        </button>
                      </div>
                      <div onClick={(e) => e.stopPropagation()}>
                        <SpeedChip speed={ttsSpeed} onCycle={cycleSpeed} />
                      </div>
                      <p className="text-xl text-app-text leading-relaxed">
                        "{vocab.context_sentence}"
                      </p>
                    </>
                  ) : phrase ? (
                    <>
                      <div data-testid="card-term" className="text-[10px] uppercase tracking-widest text-app-hint font-bold">{t('practice.prompt_phrase')}</div>
                      <div className="flex items-center gap-3 flex-wrap justify-center">
                        <h2 data-testid="card-term" className="text-2xl font-bold tracking-tight leading-snug text-center">
                          {phrase.phrase}
                        </h2>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleReplayAudio()
                          }}
                          className="w-9 h-9 rounded-full bg-app-primary/10 border border-app-primary/30 flex items-center justify-center text-base active:scale-90 transition-transform shrink-0"
                          aria-label={t('practice.tap_to_replay')}
                        >
                          <Volume2 size={20} strokeWidth={2.5} className="text-app-primary" />
                        </button>
                      </div>
                      <div onClick={(e) => e.stopPropagation()}>
                        <SpeedChip speed={ttsSpeed} onCycle={cycleSpeed} />
                      </div>
                      {phrase.pattern && (
                        <p className="text-xs text-app-hint font-mono">{phrase.pattern}</p>
                      )}
                    </>
                  ) : theory ? (
                    <div data-testid="card-term" className="overflow-y-auto max-h-full w-full px-2 text-center">
                      <Markdown className="text-xl font-bold leading-snug">
                        {theory.question}
                      </Markdown>
                    </div>
                  ) : null}
                  
                  {!expectsTypedAnswer && (
                    <div className="absolute top-4 left-6 pointer-events-none flex items-center gap-2">
                      <CardStabilityIndicator stability={currentCard!.fsrs.stability} />
                      {currentCard!.has_questions && (
                        <div className="flex items-center justify-center w-5 h-5 rounded bg-app-primary/10 text-app-primary border border-app-primary/20">
                          <HelpCircle size={10} strokeWidth={2.5} />
                        </div>
                      )}
                    </div>
                  )}

                  {currentCard!.source && !expectsTypedAnswer && (
                    <div className="absolute inset-x-0 bottom-10 text-[10px] text-app-hint uppercase tracking-[0.2em] font-bold opacity-40 pointer-events-none text-center">
                      {currentCard!.source}
                    </div>
                  )}

                  {!expectsTypedAnswer && (
                    <div className="absolute inset-x-0 bottom-4 text-[9px] text-app-hint opacity-30 uppercase font-bold tracking-[0.3em] pointer-events-none text-center">
                      {t('practice.tap_to_reveal')}
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
                  <div className="absolute top-4 right-4 flex flex-col gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setIsEditOpen(true)
                      }}
                      className="w-8 h-8 rounded-full bg-app-surface text-app-hint border border-app-border flex items-center justify-center active:scale-90 transition-transform"
                      aria-label={t('practice.action_edit')}
                    >
                      <Pencil size={14} />
                    </button>
                    {currentCard!.source && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setIsRelatedOpen(true)
                        }}
                        className="w-8 h-8 rounded-full bg-app-surface text-app-hint border border-app-border flex items-center justify-center active:scale-90 transition-transform"
                        aria-label={t('practice.action_related')}
                      >
                        <Layers size={14} />
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setIsQuestionOpen(true)
                      }}
                      className="w-8 h-8 rounded-full bg-app-surface text-app-hint border border-app-border flex items-center justify-center active:scale-90 transition-transform relative"
                      aria-label={t('practice.action_question')}
                    >
                      <HelpCircle size={14} />
                      {currentCard!.has_questions && (
                        <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-app-primary rounded-full border-2 border-app-bg" />
                      )}
                    </button>
                  </div>
                  {matchResult && expectsTypedAnswer && (
                    <ClozeFeedback
                      result={matchResult}
                      typedAnswer={typedAnswer}
                      expected={
                        vocab
                          ? variant === 'cloze'
                            ? extractClozeTerm(vocab)
                            : vocab.term
                          : phrase
                            ? variant === 'cloze'
                              ? (buildPhraseCloze(phrase.phrase, currentCard.id)?.blank ?? phrase.phrase)
                              : phrase.phrase
                            : undefined
                      }
                      hint={vocab?.translation ?? phrase?.translation}
                    />
                  )}
                  {vocab && flipForProduce ? (
                    <>
                      <div className="flex items-center gap-3">
                        <h2 data-testid="card-term" className="text-4xl font-bold tracking-tight">
                          {vocab.term}
                        </h2>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleReplayAudio()
                          }}
                          className="w-10 h-10 rounded-full bg-app-primary/10 border border-app-primary/30 flex items-center justify-center text-base active:scale-90 transition-transform"
                          aria-label={t('practice.tap_to_replay')}
                        >
                          <Volume2 size={20} strokeWidth={2.5} className="text-app-primary" />
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
                  ) : phrase ? (
                    <>
                      <div className="flex items-center gap-2 flex-wrap justify-center">
                        <h2 data-testid="card-term" className="text-2xl font-bold tracking-tight leading-snug text-center">
                          {phrase.phrase}
                        </h2>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleReplayAudio()
                          }}
                          className="w-9 h-9 rounded-full bg-app-primary/10 border border-app-primary/30 flex items-center justify-center text-base active:scale-90 transition-transform shrink-0"
                          aria-label={t('practice.tap_to_replay')}
                        >
                          <Volume2 size={20} strokeWidth={2.5} className="text-app-primary" />
                        </button>
                      </div>
                      <span className="bg-app-primary/10 text-app-primary px-4 py-1 rounded-full text-xs font-bold uppercase tracking-widest">
                        {phrase.translation}
                      </span>
                      {phrase.pattern && (
                        <p className="text-xs text-app-hint font-mono text-center">{phrase.pattern}</p>
                      )}
                      {renderSentenceWithHighlight(phrase.context_sentence, phrase.phrase)}
                    </>
                  ) : theory ? (
                    <div className="overflow-y-auto max-h-full w-full px-1">
                      <Markdown className="text-base leading-relaxed text-left">
                        {theory.answer}
                      </Markdown>
                      {currentCard!.source_quote && (
                        <div className="mt-4 pt-3 border-t border-app-border">
                          <p className="text-[10px] uppercase tracking-widest text-app-hint font-bold mb-1">
                            {t('library.detail_from_lesson')}
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
            {t('practice.rating_hint')}
          </p>
          <button 
            onClick={() => setIsSrsHelpOpen(true)}
            className="text-app-hint active:text-app-primary transition-colors"
            aria-label={t('practice.intervals_help')}
          >
            <Info size={14} />
          </button>
        </div>
        <div className="flex gap-2 h-16 relative">
          <RatingButton label={t('practice.rating_again')} sub={intervalLabels?.[RATING.Again] ?? '…'} bg="bg-rose-500/10" color="text-rose-600 dark:text-rose-400" onClick={() => handleRate(RATING.Again)} />
          <RatingButton label={t('practice.rating_hard')} sub={intervalLabels?.[RATING.Hard] ?? '…'} bg="bg-orange-500/10" color="text-orange-600 dark:text-orange-400" onClick={() => handleRate(RATING.Hard)} />
          <RatingButton label={t('practice.rating_good')} sub={intervalLabels?.[RATING.Good] ?? '…'} bg="bg-blue-500/10" color="text-blue-600 dark:text-blue-400" onClick={() => handleRate(RATING.Good)} />
          <RatingButton label={t('practice.rating_easy')} sub={intervalLabels?.[RATING.Easy] ?? '…'} bg="bg-emerald-500/10" color="text-emerald-600 dark:text-emerald-400" onClick={() => handleRate(RATING.Easy)} />

          <AnimatePresence>
            {pendingReview && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                className="absolute inset-x-2 -top-[4.5rem] flex items-center justify-between bg-app-text text-app-bg px-4 py-3 rounded-xl shadow-lg z-20 pointer-events-auto"
              >
                <span className="text-sm font-medium">
                  {t('practice.rated_label')}: <span className="font-bold">
                    {pendingReview.rating === RATING.Again && t('practice.rating_again')}
                    {pendingReview.rating === RATING.Hard && t('practice.rating_hard')}
                    {pendingReview.rating === RATING.Good && t('practice.rating_good')}
                    {pendingReview.rating === RATING.Easy && t('practice.rating_easy')}
                  </span>
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleUndo();
                  }}
                  className="text-sm font-bold text-app-bg bg-white/20 px-3 py-1 rounded-lg active:bg-white/30 transition-colors"
                >
                  {t('practice.undo')}
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
          queueState.updateCard(updated)
        }}
      />

      <RelatedCardsSheet
        cardId={currentCard?.id ?? null}
        source={currentCard?.source ?? null}
        isOpen={isRelatedOpen}
        onClose={() => setIsRelatedOpen(false)}
      />

      <QuestionSheet
        cardId={currentCard?.id ?? null}
        isOpen={isQuestionOpen}
        onClose={() => setIsQuestionOpen(false)}
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
