import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
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
  type AssignmentDto,
  type AssignmentItemDto,
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
import {
  buildAssignmentOutcome,
  buildAssignmentQueue,
  isDrillRepeat,
  shouldRequeueAfterRating,
  type AssignmentOutcome,
} from './assignmentHelpers';
import { stopSpeaking } from '../lib/tts';
import { useCardAudio } from '../hooks/useCardAudio';
import { ACTIVE_ASSIGNMENT_KEY, useActiveAssignment } from '../hooks/useActiveAssignment';
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
  /** Session driven by the active assignment rather than the FSRS due
   *  queue. Changes three things: where cards come from, that failed cards
   *  always re-queue, and that repeats are sent as drills. */
  assignmentMode?: boolean;
  /** `assignment` is non-null only for an assignment session, and carries
   *  the counts Summary needs — including when the assignment just finished
   *  and is therefore no longer fetchable as the active one. */
  onComplete: (total: number, correct: number, assignment: AssignmentOutcome | null) => void;
  onExit: () => void;
}

export function PracticeSession({ mode, assignmentMode = false, onComplete, onExit }: PracticeSessionProps) {
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

  // Soft cap from settings — null requests the entire due queue.
  const sessionLimit = useMemo(() => getSettings().sessionLimit, [])
  // Card type filter — 'all' (default) means no filter, otherwise the
  // /due query only returns cards of that type. Captured once at mount;
  // changing the setting mid-session won't change the queue (same
  // contract as sessionLimit).
  const cardTypeFilter = useMemo(() => getSettings().cardTypeFilter, [])

  // Snapshot of any paused session for THIS mode. Read once so the
  // /due query can decide whether to fetch fresh cards. The
  // usePracticeQueue hook also reads localStorage internally for its
  // own init — cheap, and avoids prop-drilling the snapshot in. Kept in
  // lockstep with the `resumable` flag passed to that hook: an assignment
  // never resumes from that store, so it must not claim to here either.
  const hasResumedSession = useMemo(
    () => !assignmentMode && loadSession(mode) !== null,
    [assignmentMode, mode],
  )

  // Assignment queue. The two sources are mutually exclusive by
  // construction: this query only runs in assignment mode, the /due query
  // below only runs outside it, so neither session type pays for the
  // other's fetch.
  const assignmentQuery = useActiveAssignment({ enabled: assignmentMode });
  const assignmentCards = useMemo(
    () => (assignmentMode ? buildAssignmentQueue(assignmentQuery.data?.items ?? []) : []),
    [assignmentMode, assignmentQuery.data?.items],
  );

  // The assignment as it stood when the queue was seeded. Pinned in a ref
  // because the query refetches every 30 s and its counts move as reviews
  // land — folding this sitting's answers into a *moving* baseline would
  // double-count them. `usePracticeQueue` seeds once for the same reason.
  const [assignmentSnapshot, setAssignmentSnapshot] = useState<
    { assignment: AssignmentDto; items: AssignmentItemDto[] } | null
  >(null);
  // Latched during render, the same React 19 idiom the card-reset below
  // uses: the value arrives from an upstream query and this is the first
  // render that can see it.
  if (assignmentMode && assignmentSnapshot === null && assignmentQuery.data?.assignment != null) {
    setAssignmentSnapshot({
      assignment: assignmentQuery.data.assignment,
      items: assignmentQuery.data.items,
    });
  }

  // Cards taken (rated Good or better) in this sitting — the server stamps
  // exactly these, so they are what Summary adds to the snapshot.
  const takenThisSession = useRef<Set<string>>(new Set());

  // /due query — gated by the resumed-session check. Resumed sessions
  // hydrate the queue from localStorage in usePracticeQueue, so we skip
  // the fetch entirely. Fresh sessions issue a single request keyed by
  // (bypassDue, sessionLimit); background refetches are ignored by the
  // hook's shouldReseed guard.
  const dueQuery = useQuery({
    queryKey: ['cards', 'due', bypassDue, sessionLimit, cardTypeFilter],
    enabled: !hasResumedSession && !assignmentMode,
    // A new sitting must fetch its own queue. Cached cards would seed the
    // working queue before the refetch finishes, replaying the previous
    // sitting and hiding the cards that are still due (seeding is one-shot).
    gcTime: 0,
    queryFn: async () => {
      const params = new URLSearchParams()
      if (bypassDue) {
        params.set('bypass_due', 'true')
        params.set('limit', '50')
      }
      if (sessionLimit !== null) params.set('limit', String(sessionLimit))
      if (cardTypeFilter !== 'all') params.set('type', cardTypeFilter)
      const qs = params.toString()
      const path = qs ? `/cards/due?${qs}` : '/cards/due'
      const res = await fetchWithAuth(path)
      if (!res.ok) throw new Error('Failed to fetch cards')
      return (await res.json()) as { cards: DueCardDto[] }
    },
  })

  // Loading and error must come from whichever query is actually driving
  // this session. A disabled query in React Query v5 reports
  // `isLoading === false` and `error === null` forever, so reading them off
  // /due in assignment mode meant that while /assignments/active was still
  // in flight — or after it failed — the learner fell straight through to
  // the "you're all done, have a coffee" empty state.
  const isLoading = assignmentMode ? assignmentQuery.isPending : dueQuery.isLoading
  const error = assignmentMode ? assignmentQuery.error : dueQuery.error

  const [isRevealed, setIsRevealed] = useState(false);
  // Cloze-only state — reset on each card via the effect below.
  const [typedAnswer, setTypedAnswer] = useState('');
  const [matchResult, setMatchResult] = useState<MatchResult | null>(null);
  const [translationTooltip, setTranslationTooltip] = useState<{ text: string; translation: string | null; x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

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
  }, [handleExit, isExiting, t])

  const queryClient = useQueryClient();

  const reviewMutation = useMutation({
    mutationFn: async ({ id, rating, drill }: { id: string; rating: Rating; drill: boolean }) => {
      const res = await fetchWithAuth(`/cards/${id}/review`, {
        method: 'POST',
        body: JSON.stringify({ rating, drill }),
      });
      if (!res.ok) throw new Error('Failed to submit review');
      return res.json();
    },
    onSuccess: () => {
      // Keeps Home's ring and the group counters honest the moment the
      // user backs out mid-assignment.
      if (assignmentMode) void queryClient.invalidateQueries({ queryKey: ACTIVE_ASSIGNMENT_KEY });
    },
  });

  // Cards already answered in this sitting. Drives the drill decision —
  // the first answer for a card is the measurement, every repeat after it
  // is training and must not touch FSRS.
  const answeredThisSession = useRef<Set<string>>(new Set());

  // Typed-answer modes (cloze/translation/listening) have no sensible
  // rendering for theory cards — they have no `term` to gap-fill,
  // translate, or pronounce. Two cases:
  //   * type filter = 'all' / 'vocab' / 'phrase' AND mode is typed-answer
  //     → drop theory cards so the session stays coherent with the mode
  //   * type filter = 'theory' AND mode is typed-answer
  //     → that's a contradiction the type-filter UI should prevent, but
  //       if it happens (e.g. mid-deploy stale state) we DON'T filter
  //       theory out — letting the session be empty was worse than just
  //       running the session in recognition. The variant resolver below
  //       already forces theory → recognition, so the only thing we'd
  //       lose by NOT filtering is the original mode's variant — which
  //       doesn't apply to theory anyway.
  const baseCards = useMemo<DueCardDto[]>(() => {
    const all = assignmentMode ? assignmentCards : (dueQuery.data?.cards ?? []);
    const typedAnswerMode = mode === 'cloze' || mode === 'translation' || mode === 'listening'
    // …and never in an assignment. An item the queue drops can never be
    // answered, so it never completes, so the assignment never settles —
    // it holds Home and blocks the next one until its deadline lapses. A
    // saved mode preference must not be able to wedge the feature. The
    // variant resolver degrades theory to recognition anyway, which is
    // exactly the trade the comment above already accepts.
    if (typedAnswerMode && !assignmentMode && cardTypeFilter !== 'theory') {
      return all.filter((c) => c.type !== 'theory');
    }
    return all;
  }, [assignmentMode, assignmentCards, dueQuery.data?.cards, mode, cardTypeFilter]);

  // Queue + cursor + stats + pending-review undo slot + session-id ref
  // all live in this hook. See hooks/usePracticeQueue.ts for the why —
  // short version: the lock/unlock regression was a queue state-machine
  // bug, isolating the state makes it both easier to reason about and
  // easier to write regression tests for (see practiceHelpers.test.ts).
  const queueState = usePracticeQueue({ mode, baseCards, resumable: !assignmentMode })
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
        reviewMutation.mutate({ id: pending.id, rating: pending.rating, drill: pending.drill });
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
  // Vocab cloze also degrades to recognition when the card has no context
  // sentence (cabinet-edited cards can clear it) — there's nothing to blank.
  const variant: ExerciseVariant = (() => {
    if (currentCard === undefined) return 'recognition'
    if (currentCard.type === 'theory') return 'recognition'
    const picked = pickVariantFor(mode, currentCard.id)
    if (
      picked === 'cloze' &&
      currentCard.type === 'vocab' &&
      (currentCard.payload as VocabPayload).context_sentence.length === 0
    ) {
      return 'recognition'
    }
    return picked
  })()

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

    // Measurement vs training. Only assignments cram a card until it
    // sticks, so only they can produce a repeat — a free session keeps
    // posting honest reviews exactly as it always has.
    const drill = assignmentMode && isDrillRepeat(currentCard, answeredThisSession.current, new Date());
    answeredThisSession.current.add(currentCard.id);

    if (rating === RATING.Again) { haptic('notificationOccurred', 'error'); playThudSound(); }
    else if (rating === RATING.Hard) { haptic('impactOccurred', 'medium'); playPopSound(); }
    else if (rating === RATING.Good) { haptic('selectionChanged'); playPopSound(); }
    else { haptic('notificationOccurred', 'success'); playPopSound(); }

    // "Correct" = the user confidently retrieved the card. Hard means
    // "remembered with significant effort" — that's not a failure
    // (FSRS only treats Again as a lapse), but it's not a confident
    // recall either, so it doesn't count toward the user-facing
    // accuracy %. Backend aggregates use the same `rating >= 3`
    // threshold so the per-session row and today/week/month numbers
    // tell the same story.
    const isCorrect = rating >= RATING.Good;
    const correctDelta: 0 | 1 = isCorrect ? 1 : 0;
    // Good or better is exactly what the server stamps as taken.
    if (isCorrect) takenThisSession.current.add(currentCard.id);
    const nextStats = {
      total: sessionStats.total + 1,
      correct: sessionStats.correct + correctDelta,
    }

    // Auto-replay: re-queue this card a few positions ahead so the user sees
    // it again in the same session (Anki learning-steps style). In free
    // practice that's Again only and gated by a setting (default off); in an
    // assignment it's Again *or* Hard and not a preference — see
    // shouldRequeueAfterRating.
    let replaySpliceIndex: number | null = null;
    let workingLength = queue.length;
    if (shouldRequeueAfterRating(rating, assignmentMode, getSettings().inSessionReplay)) {
      replaySpliceIndex = queueState.spliceAhead(currentCard);
      workingLength = queue.length + 1;
    }

    // Flush any existing pending review immediately before queueing the next one.
    if (pendingReview) {
      clearTimeout(pendingReview.timeoutId);
      reviewMutation.mutate({ id: pendingReview.id, rating: pendingReview.rating, drill: pendingReview.drill });
    }

    // Delay the API call by 3.5 seconds to allow undo.
    const timeoutId = window.setTimeout(() => {
      reviewMutation.mutate({ id: currentCard.id, rating, drill });
      setPendingReview(null);
    }, 3500);

    setPendingReview({
      id: currentCard.id,
      rating,
      drill,
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
      reviewMutation.mutate({ id: currentCard.id, rating, drill });

      haptic('notificationOccurred', 'success')
      playSuccessChime()
      queueState.finishBackendSession(nextStats.total, nextStats.correct)
      queueState.markFinished();
      onComplete(
        nextStats.total,
        nextStats.correct,
        assignmentSnapshot === null
          ? null
          : buildAssignmentOutcome(
              assignmentSnapshot.assignment,
              assignmentSnapshot.items,
              takenThisSession.current,
            ),
      );
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
    // Undo the drill bookkeeping too, or the re-answer would count as a
    // repeat and never reach FSRS. Only when this rating WAS the
    // measurement — undoing a repeat must leave the earlier answer on
    // the record.
    if (!pendingReview.drill) answeredThisSession.current.delete(pendingReview.id);
    // The undone rating never reaches the server, so it never stamped the
    // assignment item either — Summary's count must forget it too.
    if (pendingReview.rating >= RATING.Good) takenThisSession.current.delete(pendingReview.id);
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
      // Surrounding sentence helps the LLM disambiguate ("like" the
      // verb vs "like" the preposition). Pulled from whichever payload
      // the current card carries — vocab and phrase both have one.
      const contextSentence =
        currentCard?.type === 'vocab'
          ? (currentCard.payload as VocabPayload).context_sentence
          : currentCard?.type === 'phrase'
            ? (currentCard.payload as PhrasePayload).context_sentence
            : ''
      const params = new URLSearchParams({
        text: cleanWord,
        from: learningLanguage,
        to: nativeLanguage,
      })
      if (contextSentence) params.set('context', contextSentence)
      const res = await fetchWithAuth(`/translate?${params.toString()}`);
      if (res.ok) {
        // Backend returns up to 3 candidates — context-aware via LLM
        // when configured, MyMemory ranked-top-3 otherwise. Joining
        // with " · " shows multiple senses so the learner can pick.
        const { translations } = (await res.json()) as { translations?: string[] };
        const translation = (translations ?? []).join(' · ');
        if (translation.length > 0) {
          setTranslationTooltip(prev => prev ? { ...prev, translation } : null);
        }
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
          {/* Never in an assignment: the queue IS the assignment, so
              bypass_due has nothing to fetch — the /due query stays
              disabled and the button would be a dead end. */}
          {!bypassDue && !assignmentMode && (
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
              bypassDue || assignmentMode
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
    // Cabinet-edited cards may have no context sentence — render nothing
    // so the surrounding layout collapses cleanly.
    if (sentence.length === 0) return null
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
            initial={{ opacity: 0, x: 50, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: -50, scale: 0.9, pointerEvents: 'none' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            onClick={expectsTypedAnswer ? undefined : handleReveal}
            className={`w-full aspect-[3/4] bg-app-surface rounded-[2.5rem] relative border border-app-border shadow-xl overflow-hidden ${
              expectsTypedAnswer ? '' : 'cursor-pointer'
            }`}
            whileTap={expectsTypedAnswer ? undefined : { scale: 0.98 }}
            data-testid="card-ready"
          >
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
                      {/* Translation hint above the cloze sentence.
                          Without it, sentences like "I didn't hear any
                          ___ from that company." are unfair — too many
                          words fit. The hint turns the exercise into
                          "produce the foreign form given meaning +
                          context" instead of "guess what the LLM
                          picked." */}
                      <div className="flex flex-col items-center gap-2 mb-4 shrink-0">
                        <div className="bg-app-primary/10 text-app-primary px-2.5 py-0.5 rounded-lg text-[9px] font-black uppercase tracking-[0.15em] border border-app-primary/20">
                          {t('practice.prompt_translation')}
                        </div>
                        <div className="text-base text-app-text font-bold text-center leading-tight px-2 max-w-[280px]">
                          {vocab.translation}
                        </div>
                      </div>
                      <p className="text-lg text-app-text leading-relaxed text-center px-4">
                        {clozePrompt.before}
                        <span className="text-app-primary font-black underline underline-offset-4 decoration-2">{'_'.repeat(Math.max(3, Math.min(12, clozePrompt.targetLength)))}</span>
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
                      {vocab.context_sentence.length > 0 && (
                        <p className="text-xl text-app-text leading-relaxed">
                          "{vocab.context_sentence}"
                        </p>
                      )}
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
                  className="absolute inset-0 px-6 pt-6 pb-20 flex flex-col items-center justify-center gap-5"
                >
                  <div className="absolute bottom-5 inset-x-0 flex justify-center gap-4">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setIsEditOpen(true)
                      }}
                      className="w-10 h-10 rounded-full bg-app-surface text-app-hint border border-app-border flex items-center justify-center active:scale-90 transition-transform shadow-sm"
                      aria-label={t('practice.action_edit')}
                    >
                      <Pencil size={18} />
                    </button>
                    {currentCard!.source && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setIsRelatedOpen(true)
                        }}
                        className="w-10 h-10 rounded-full bg-app-surface text-app-hint border border-app-border flex items-center justify-center active:scale-90 transition-transform shadow-sm"
                        aria-label={t('practice.action_related')}
                      >
                        <Layers size={18} />
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setIsQuestionOpen(true)
                      }}
                      className="w-10 h-10 rounded-full bg-app-surface text-app-hint border border-app-border flex items-center justify-center active:scale-90 transition-transform shadow-sm relative"
                      aria-label={t('practice.action_question')}
                    >
                      <HelpCircle size={18} />
                      {currentCard!.has_questions && (
                        <div className="absolute top-0 right-0 w-3 h-3 bg-app-primary rounded-full border-2 border-app-bg" />
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

      {/* Rating Buttons & Undo Snackbar */}
      <div
        className={`px-2 pb-10 pt-4 transition-all duration-300 ${
          isRevealed || pendingReview ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'
        }`}
        style={{ paddingBottom: `calc(2.5rem + var(--tg-safe-area-inset-bottom, 0px))` }}
      >
        {/* Tells the user the rating row is the way forward, not a result of
            their typed answer. Empirically the most common confusion. */}
        <div className={`flex items-center justify-center gap-1.5 pb-2 px-3 transition-opacity ${isRevealed && !pendingReview ? 'opacity-100' : 'opacity-0'}`}>
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
          {/* Rating Buttons - only visible when revealed and NOT undoing */}
          <div className={`absolute inset-0 flex gap-2 transition-opacity duration-200 ${isRevealed && !pendingReview ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
            <RatingButton label={t('practice.rating_again')} sub={intervalLabels?.[RATING.Again] ?? '…'} bg="bg-rose-500/10" color="text-rose-600 dark:text-rose-400" onClick={() => handleRate(RATING.Again)} />
            <RatingButton label={t('practice.rating_hard')} sub={intervalLabels?.[RATING.Hard] ?? '…'} bg="bg-orange-500/10" color="text-orange-600 dark:text-orange-400" onClick={() => handleRate(RATING.Hard)} />
            <RatingButton label={t('practice.rating_good')} sub={intervalLabels?.[RATING.Good] ?? '…'} bg="bg-blue-500/10" color="text-blue-600 dark:text-blue-400" onClick={() => handleRate(RATING.Good)} />
            <RatingButton label={t('practice.rating_easy')} sub={intervalLabels?.[RATING.Easy] ?? '…'} bg="bg-emerald-500/10" color="text-emerald-600 dark:text-emerald-400" onClick={() => handleRate(RATING.Easy)} />
          </div>

          <AnimatePresence>
            {pendingReview && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                className="absolute inset-x-0 inset-y-0 flex items-center justify-between bg-app-text text-app-bg px-5 py-3 rounded-2xl shadow-xl z-20 pointer-events-auto"
              >
                <div className="flex items-center gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-app-bg animate-pulse" />
                  <span className="text-sm font-bold tracking-tight">
                    {t('practice.rated_label')}: <span className="uppercase">
                      {pendingReview.rating === RATING.Again && t('practice.rating_again')}
                      {pendingReview.rating === RATING.Hard && t('practice.rating_hard')}
                      {pendingReview.rating === RATING.Good && t('practice.rating_good')}
                      {pendingReview.rating === RATING.Easy && t('practice.rating_easy')}
                    </span>
                  </span>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleUndo();
                  }}
                  className="px-4 py-1.5 rounded-lg bg-app-bg/10 text-app-bg font-black text-[10px] uppercase tracking-wider border border-app-bg/20 active:scale-95 transition-transform"
                >
                  {t('common.cancel')}
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
            className="fixed z-[100] px-4 py-2 bg-zinc-900/90 backdrop-blur-md text-white rounded-2xl shadow-2xl border border-white/20 flex flex-col items-center text-center gap-0.5 max-w-[240px]"
            style={{ 
              left: Math.max(16, Math.min(window.innerWidth - 256, translationTooltip.x - 120)),
              top: translationTooltip.y - 85 
            }}
          >
            <div className="text-[9px] uppercase font-black text-white/40 tracking-[0.2em]">{translationTooltip.text}</div>
            <div className="text-sm font-bold leading-tight">
              {translationTooltip.translation || '...'}
            </div>
            {/* Tooltip arrow */}
            <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-zinc-900/90 rotate-45 border-r border-b border-white/20" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
