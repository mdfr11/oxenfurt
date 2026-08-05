// The assignment block on Home. A dial-sized ring carrying the count, the
// agent and the deadline beside it, and one bar per group underneath.
//
// Answers "why exactly this, today" — without the group breakdown an
// assignment reads as a random pile and the agent's judgement is invisible.
// The bars answer the follow-up: four fragile old cards left is a different
// evening from twelve new ones, and the counts alone make you do that
// arithmetic yourself.

import { useMemo } from 'react';
import type { AssignmentDto } from '@oxenfurt/shared';
import { deadlineState } from './assignmentHelpers';
import { useT } from '../lib/i18n/useT';

interface AssignmentCardProps {
  assignment: AssignmentDto;
  onOpenRationale: () => void;
}

// Ring geometry in viewBox units. The full-size ring on the no-assignment
// screen is 224px wide with an 8px stroke; scaled down to 64px that stroke
// becomes a hairline and an unstarted assignment draws nothing at all — the
// hole the owner saw. Here the stroke is a fifth of the radius, so the track
// reads as a dial even at 0/20, and the arc reads as an arc from the first
// card answered.
const RING_RADIUS = 80;
const RING_STROKE = 16;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function AssignmentCard({ assignment, onOpenRationale }: AssignmentCardProps) {
  const t = useT();
  // Pinned to the deadline rather than re-read on every render — Home
  // re-renders on a 30 s refetch cadence and the day count cannot change
  // between two of those.
  const { days, urgent } = useMemo(
    () => deadlineState(assignment.due_at, new Date()),
    [assignment.due_at],
  );

  const percent = assignment.total > 0 ? (assignment.completed / assignment.total) * 100 : 0;
  const strokeDashoffset = RING_CIRCUMFERENCE - (percent / 100) * RING_CIRCUMFERENCE;

  return (
    <div className="w-full flex flex-col gap-3.5">
      <button
        onClick={onOpenRationale}
        disabled={assignment.rationale === null}
        className="w-full flex items-center gap-3.5 bg-app-surface border border-app-border rounded-2xl p-3.5 shadow-sm text-left active:opacity-70 transition-opacity"
      >
        {/* Spans, not <div>/<h2>/<p>: a button may only contain phrasing
            content. Layout comes from the classes. */}
        <span className="relative w-16 h-16 shrink-0 flex items-center justify-center">
          <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 200 200" aria-hidden="true">
            <circle
              cx="100"
              cy="100"
              r={RING_RADIUS}
              stroke="currentColor"
              strokeWidth={RING_STROKE}
              fill="transparent"
              className="text-app-primary/20"
            />
            <circle
              cx="100"
              cy="100"
              r={RING_RADIUS}
              stroke="currentColor"
              strokeWidth={RING_STROKE}
              fill="transparent"
              strokeLinecap="round"
              className="text-app-primary"
              style={{ strokeDasharray: RING_CIRCUMFERENCE, strokeDashoffset }}
            />
          </svg>
          <span className="relative font-black tracking-tighter leading-none text-app-text text-[17px] tabular-nums">
            {assignment.completed}
            <span className="text-[10px] opacity-40">/{assignment.total}</span>
          </span>
        </span>

        <span className="flex-1 min-w-0">
          <span className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-app-hint opacity-70 truncate">
              {t('assignment.from_agent')}
            </span>
            <span
              className={`text-[10px] font-bold uppercase tracking-wider shrink-0 ${
                urgent ? 'text-orange-400' : 'text-app-hint opacity-70'
              }`}
            >
              {urgent ? t('assignment.due_today') : t('assignment.due_days', { days: String(days) })}
            </span>
          </span>
          <span className="block mt-1.5 text-[13px] font-black tracking-tight leading-snug text-app-text line-clamp-2">
            {assignment.title}
          </span>
        </span>
      </button>

      {/* Empty only when every card in the assignment has been archived —
          rendering the container anyway would leave a floating gap. */}
      {assignment.groups.length > 0 && (
        <div className="w-full flex flex-col gap-3.5 px-1">
          {assignment.groups.map((group) => {
            const weak = group.kind === 'weak';
            const groupPercent = group.total > 0 ? (group.completed / group.total) * 100 : 0;
            return (
              <div key={group.label} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2.5 text-[11px]">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      weak ? 'bg-orange-400' : 'bg-app-primary'
                    }`}
                  />
                  <span className="flex-1 text-app-text/85 truncate">{group.label}</span>
                  <span className="text-app-hint/70 font-black text-[10px] tabular-nums">
                    {group.completed}/{group.total}
                  </span>
                </div>
                {/* Inset to the label rather than spanning the row: a rule that
                    starts at the dot and runs the full width reads as a divider
                    between groups, which is the opposite of what it is.
                    Decorative to a screen reader — the count beside the label
                    already says it, and saying it twice is noise. */}
                <div
                  aria-hidden="true"
                  className={`ml-4 h-[3px] rounded-full overflow-hidden ${
                    weak ? 'bg-orange-400/15' : 'bg-app-primary/15'
                  }`}
                >
                  <div
                    className={`h-full rounded-full ${weak ? 'bg-orange-400' : 'bg-app-primary'}`}
                    style={{ width: `${groupPercent}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
