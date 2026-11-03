import { useEffect, useRef } from 'react';
import { sendData } from '@telegram-apps/sdk-react';
import { CheckCircle2 } from 'lucide-react';
import confetti from 'canvas-confetti';
import { useT } from '../lib/i18n/useT';
import { plurKey } from '../lib/i18n/plural';
import {
  GROUP_KIND_I18N_KEY,
  type AssignmentOutcome,
  type DrillOutcome,
} from './assignmentHelpers';

interface SummaryProps {
  stats: { total: number; correct: number };
  /** Set only after an assignment session. Turns the generic "you reviewed
   *  N cards" into what the sitting was actually for. */
  assignment?: AssignmentOutcome | null;
  /** Set only after a drill round ("Круги") of a replayed assignment. */
  drill?: DrillOutcome | null;
  onFinish: () => void;
  /** Free practice over the due queue — kept for the free-session path. */
  onRepeatHard: () => void;
  /** Starts another round over the same assignment. After an assignment
   *  session this opens the first replay round; after a drill round it opens
   *  the next one. */
  onRepeat: () => void;
}

export function Summary({
  stats,
  assignment = null,
  drill = null,
  onFinish,
  onRepeatHard,
  onRepeat,
}: SummaryProps) {
  const t = useT()
  const accuracy = stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 100;
  const wrong = stats.total - stats.correct;
  const sentRef = useRef(false)
  const assignmentDone = assignment !== null && assignment.completed >= assignment.total;
  const isDrill = drill !== null;
  // The finished assignment is still replayable: its id comes from whichever
  // outcome the sitting produced.
  const replayableId = drill?.assignmentId ?? assignment?.assignmentId ?? null;

  useEffect(() => {
    // Elegant, subtle confetti burst
    confetti({
      particleCount: 80,
      spread: 60,
      origin: { y: 0.4 },
      colors: ['#10b981', '#3b82f6', '#f59e0b'],
      disableForReducedMotion: true
    });
  }, []);

  // Send a one-line session summary back to the bot chat via sendData().
  // The Hermes agent receives it and can comment in the chat.
  useEffect(() => {
    if (sentRef.current) return
    sentRef.current = true
    try {
      const payload = JSON.stringify({
        kind: 'oxenfurt_session_summary',
        version: 1,
        total: stats.total,
        correct: stats.correct,
        wrong,
        accuracy_percent: accuracy,
        finished_at: new Date().toISOString(),
        // Lets Hermes know that a sitting was a replay round rather than a
        // fresh session, without inventing a second message.
        assignment_id: replayableId,
        assignment_round: drill?.round ?? null,
      })
      sendData(payload)
    } catch {
      // sendData is only available when the Mini App was opened inline (web_app
      // button from a bot). Not available in dev or when opened from a direct
      // link — silently skip in those cases.
    }
  }, [stats.total, stats.correct, wrong, accuracy, replayableId, drill?.round])

  // A drill round is training, not submission: never say "задание сдано"
  // for it, and never route its "repeat" through free practice.
  const headline = isDrill
    ? t('drill.title', { round: drill.round })
    : assignmentDone
      ? t('assignment.done_title')
      : t('summary.title');

  const subtitle = isDrill
    ? t('drill.subtitle', { correct: drill.correct, total: drill.total })
    : assignmentDone
      ? t('assignment.done_desc')
      : t(plurKey(stats.total, 'summary.subtitle_one', 'summary.subtitle_few', 'summary.subtitle_many'), { n: stats.total });

  return (
    <div
      className="flex-1 flex flex-col p-6 justify-between bg-app-bg text-app-text"
      style={{
        paddingTop: `calc(1.5rem + var(--tg-safe-area-inset-top, 0px))`,
        paddingBottom: `calc(2rem + var(--tg-safe-area-inset-bottom, 0px))`,
      }}
    >
      <div className="flex-1 flex flex-col items-center justify-center text-center">
        <div className="w-20 h-20 bg-emerald-500 rounded-full flex items-center justify-center text-white shadow-lg shadow-emerald-500/20 mb-6">
          <CheckCircle2 size={40} />
        </div>
        <h1 className="text-2xl font-bold mb-2">{headline}</h1>
        <p className="text-app-hint mb-2">{subtitle}</p>

        {isDrill && (
          <div className="w-full max-w-[300px] mb-8 mt-4 flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12px] font-black tracking-tight leading-snug text-app-text text-left truncate">
                {drill.title}
              </span>
              <span className="text-[11px] font-black tabular-nums text-app-hint/70 shrink-0">
                {t('drill.round_label', { round: drill.round })}
              </span>
            </div>
          </div>
        )}

        {!isDrill && assignment !== null && (
          <div className="w-full max-w-[300px] mb-8 mt-4 flex flex-col gap-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12px] font-black tracking-tight leading-snug text-app-text text-left truncate">
                {assignment.title}
              </span>
              <span className="text-[11px] font-black tabular-nums text-app-hint/70 shrink-0">
                {t('assignment.progress', {
                  completed: String(assignment.completed),
                  total: String(assignment.total),
                })}
              </span>
            </div>
            {assignment.groups.map((group) => (
              <div key={group.label} className="flex items-center gap-2.5 text-[11px]">
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    group.completed >= group.total ? 'bg-emerald-500' : 'bg-app-hint/40'
                  }`}
                />
                {/* The agent's own label leads; the kind is the quiet
                    qualifier that says why the group is in the assignment. */}
                <span className="flex-1 text-app-text/85 truncate text-left">{group.label}</span>
                <span className="text-app-hint/60 uppercase tracking-wider text-[9px] font-bold shrink-0">
                  {t(GROUP_KIND_I18N_KEY[group.kind])}
                </span>
                <span className="text-app-hint/70 font-black text-[10px] tabular-nums shrink-0">
                  {group.completed}/{group.total}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className={`w-full grid grid-cols-2 gap-4 bg-app-surface border border-app-border p-6 rounded-2xl shadow-sm ${assignment === null && !isDrill ? 'mt-10' : ''}`}>
          <div className="flex flex-col">
            <span className="text-2xl font-bold">{accuracy}%</span>
            <span className="text-[10px] uppercase tracking-wider text-app-hint font-bold mt-1">{t('summary.accuracy')}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-2xl font-bold">{wrong}</span>
            <span className="text-[10px] uppercase tracking-wider text-app-hint font-bold mt-1">{t('summary.lapses')}</span>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {isDrill ? (
          <>
            <button
              className="w-full bg-app-primary text-app-primary-text py-4 rounded-2xl font-semibold active:scale-95 transition-transform shadow-lg shadow-app-primary/20"
              onClick={onRepeat}
            >
              {t('drill.cta_again')}
            </button>
            <button
              className="w-full bg-app-surface border border-app-border text-app-text py-4 rounded-2xl font-semibold active:scale-95 transition-transform"
              onClick={onFinish}
            >
              {t('drill.cta_finish')}
            </button>
          </>
        ) : assignment !== null ? (
          <>
            {/* The assignment is the thing being practised; a finished one
                stays replayable instead of counting as the end of the story.
                Free practice ("Повторить трудные") is deliberately absent:
                after a replay exists, it is the honest way to see these cards
                again, and it keeps same-day repeats out of FSRS. */}
            <button
              className="w-full bg-app-primary text-app-primary-text py-4 rounded-2xl font-semibold active:scale-95 transition-transform shadow-lg shadow-app-primary/20"
              onClick={onRepeat}
            >
              {t('drill.cta_again')}
            </button>
            <button
              className="w-full bg-app-surface border border-app-border text-app-text py-4 rounded-2xl font-semibold active:scale-95 transition-transform"
              onClick={onFinish}
            >
              {t('summary.btn_done')}
            </button>
          </>
        ) : (
          <>
            {wrong > 0 && (
              <button
                className="w-full bg-app-surface border border-app-border text-app-text py-4 rounded-2xl font-semibold active:scale-95 transition-transform"
                onClick={onRepeatHard}
              >
                {t('summary.btn_repeat_hard')}
              </button>
            )}
            <button
              className="w-full bg-app-primary text-app-primary-text py-4 rounded-2xl font-semibold active:scale-95 transition-transform shadow-lg shadow-app-primary/20"
              onClick={onFinish}
            >
              {t('summary.btn_done')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
