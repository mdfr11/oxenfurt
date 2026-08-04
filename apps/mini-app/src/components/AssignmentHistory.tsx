// The artifact side of assignments: what was set, what was actually taken.
// This is what gets opened in front of the tutor at the next lesson, which
// is why expired rows show their real numbers instead of being hidden.

import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { AssignmentListItemDto } from '@oxenfurt/shared';
import { fetchWithAuth } from '../lib/api';
import { BottomSheet } from './BottomSheet';
import { useT } from '../lib/i18n/useT';

interface AssignmentHistoryProps {
  isOpen: boolean;
  onClose: () => void;
}

const STATUS_KEY = {
  active: 'assignment.status_active',
  completed: 'assignment.status_completed',
  expired: 'assignment.status_expired',
} as const;

export function AssignmentHistory({ isOpen, onClose }: AssignmentHistoryProps) {
  const t = useT();
  const { data } = useQuery({
    queryKey: ['assignments', 'history'],
    enabled: isOpen,
    queryFn: async () => {
      const res = await fetchWithAuth('/assignments');
      if (!res.ok) throw new Error('Failed to fetch assignments');
      return (await res.json()) as { assignments: AssignmentListItemDto[] };
    },
  });

  const rows = data?.assignments ?? [];

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} maxHeight="75vh">
      <div className="flex justify-between items-start mb-4 text-app-text gap-3">
        <h2 className="text-lg font-bold leading-tight">{t('assignment.history_title')}</h2>
        <button
          onClick={onClose}
          className="p-2 -mr-2 shrink-0 text-app-hint active:scale-95 transition-transform"
          aria-label={t('common.close')}
        >
          <X size={20} />
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="text-center text-app-hint text-xs py-8">{t('assignment.history_empty')}</p>
      ) : (
        <div className="flex flex-col gap-2 pb-4">
          {rows.map((row) => (
            <div
              key={row.id}
              className="bg-app-surface border border-app-border rounded-2xl px-4 py-3"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="text-[12px] font-bold text-app-text leading-snug flex-1">
                  {row.title}
                </span>
                <span className="text-[9px] font-black uppercase tracking-wider text-app-hint/70 shrink-0 pt-0.5">
                  {t(STATUS_KEY[row.status])}
                </span>
              </div>
              <div className="flex items-center justify-between mt-2 text-[10px] text-app-hint/70">
                <span className="tabular-nums">
                  {t('assignment.progress', {
                    completed: String(row.completed),
                    total: String(row.total),
                  })}
                </span>
                <span>{new Date(row.due_at).toLocaleDateString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ height: 'calc(0.5rem + var(--tg-safe-area-inset-bottom, 0px))' }} />
    </BottomSheet>
  );
}
