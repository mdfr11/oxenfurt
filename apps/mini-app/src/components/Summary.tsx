import { useEffect, useRef } from 'react';
import { sendData } from '@telegram-apps/sdk-react';
import { CheckCircle2 } from 'lucide-react';
import confetti from 'canvas-confetti';
import { useT } from '../lib/i18n/useT';
import { plurKey } from '../lib/i18n/plural';
import type { AssignmentOutcome } from './assignmentHelpers';

interface SummaryProps {
  stats: { total: number; correct: number };
  /** Set only after an assignment session. Turns the generic "you reviewed
   *  N cards" into what the sitting was actually for. */
  assignment?: AssignmentOutcome | null;
  onFinish: () => void;
  onRepeatHard: () => void;
}

const GROUP_KIND_KEY = {
  topic: 'assignment.group_topic',
  new: 'assignment.group_new',
  weak: 'assignment.group_weak',
} as const;

export function Summary({ stats, assignment = null, onFinish, onRepeatHard }: SummaryProps) {
  const t = useT()
  const accuracy = stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 100;
  const wrong = stats.total - stats.correct;
  const sentRef = useRef(false)
  // "Submitted" is the whole point of an assignment, so it gets the headline
  // — but only when the assignment is genuinely closed. A partial sitting
  // says how far it got and stays quiet about it.
  const assignmentDone = assignment !== null && assignment.completed >= assignment.total;

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
      })
      sendData(payload)
    } catch {
      // sendData is only available when the Mini App was opened inline (web_app
      // button from a bot). Not available in dev or when opened from a direct
      // link — silently skip in those cases.
    }
  }, [stats.total, stats.correct, wrong, accuracy])

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
        <h1 className="text-2xl font-bold mb-2">
          {assignmentDone ? t('assignment.done_title') : t('summary.title')}
        </h1>
        <p className="text-app-hint mb-2">
          {assignmentDone
            ? t('assignment.done_desc')
            : t(plurKey(stats.total, 'summary.subtitle_one', 'summary.subtitle_few', 'summary.subtitle_many'), { n: stats.total })}
        </p>

        {assignment !== null && (
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
                  {t(GROUP_KIND_KEY[group.kind])}
                </span>
                <span className="text-app-hint/70 font-black text-[10px] tabular-nums shrink-0">
                  {group.completed}/{group.total}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className={`w-full grid grid-cols-2 gap-4 bg-app-surface border border-app-border p-6 rounded-2xl shadow-sm ${assignment === null ? 'mt-10' : ''}`}>
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
      </div>
    </div>
  );
}

