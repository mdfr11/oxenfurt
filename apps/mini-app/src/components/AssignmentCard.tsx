// The block under the ring on Home. Answers "why exactly this, today" —
// without the group breakdown an assignment reads as a random pile and the
// agent's judgement is invisible.

import type { AssignmentDto } from '@oxenfurt/shared';
import { deadlineState } from './assignmentHelpers';
import { useT } from '../lib/i18n/useT';

interface AssignmentCardProps {
  assignment: AssignmentDto;
  onOpenRationale: () => void;
}

export function AssignmentCard({ assignment, onOpenRationale }: AssignmentCardProps) {
  const t = useT();
  const { days, urgent } = deadlineState(assignment.due_at, new Date());

  return (
    <div className="w-full max-w-[340px] flex flex-col items-center gap-3">
      <button
        onClick={onOpenRationale}
        disabled={assignment.rationale === null}
        className="text-center px-2 active:opacity-70 transition-opacity disabled:active:opacity-100"
      >
        <h2 className="text-[13px] font-black tracking-tight leading-snug text-app-text">
          {assignment.title}
        </h2>
        <p
          className={`text-[10px] font-bold uppercase tracking-wider mt-1.5 ${
            urgent ? 'text-orange-400' : 'text-app-hint opacity-70'
          }`}
        >
          {t('assignment.from_agent')} ·{' '}
          {urgent ? t('assignment.due_today') : t('assignment.due_days', { days: String(days) })}
        </p>
      </button>

      <div className="w-full flex flex-col gap-1.5 px-1">
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
    </div>
  );
}
