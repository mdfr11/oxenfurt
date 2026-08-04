// The block under the ring on Home. Answers "why exactly this, today" —
// without the group breakdown an assignment reads as a random pile and the
// agent's judgement is invisible.

import { useMemo } from 'react';
import type { AssignmentDto } from '@oxenfurt/shared';
import { deadlineState } from './assignmentHelpers';
import { useT } from '../lib/i18n/useT';

interface AssignmentCardProps {
  assignment: AssignmentDto;
  onOpenRationale: () => void;
}

export function AssignmentCard({ assignment, onOpenRationale }: AssignmentCardProps) {
  const t = useT();
  // Pinned to the deadline rather than re-read on every render — Home
  // re-renders on a 30 s refetch cadence and the day count cannot change
  // between two of those.
  const { days, urgent } = useMemo(
    () => deadlineState(assignment.due_at, new Date()),
    [assignment.due_at],
  );

  return (
    <div className="w-full max-w-[340px] flex flex-col items-center gap-4">
      <button
        onClick={onOpenRationale}
        disabled={assignment.rationale === null}
        className="text-center px-2 active:opacity-70 transition-opacity"
      >
        {/* Spans, not <h2>/<p>: a button may only contain phrasing content. */}
        <span className="block text-[13px] font-black tracking-tight leading-snug text-app-text">
          {assignment.title}
        </span>
        <span
          className={`block text-[10px] font-bold uppercase tracking-wider mt-1.5 ${
            urgent ? 'text-orange-400' : 'text-app-hint opacity-70'
          }`}
        >
          {t('assignment.from_agent')} ·{' '}
          {urgent ? t('assignment.due_today') : t('assignment.due_days', { days: String(days) })}
        </span>
      </button>

      {/* Empty only when every card in the assignment has been archived —
          rendering the container anyway would leave a floating gap. */}
      {assignment.groups.length > 0 && (
        <div className="w-full flex flex-col gap-2.5 px-1">
          {assignment.groups.map((group) => (
            <div key={group.label} className="flex items-center gap-2.5 text-[11px]">
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  group.kind === 'weak' ? 'bg-orange-400' : 'bg-app-primary'
                }`}
              />
              <span className="flex-1 text-app-text/85 truncate">{group.label}</span>
              <span className="text-app-hint/70 font-black text-[10px] tabular-nums">
                {group.completed}/{group.total}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
