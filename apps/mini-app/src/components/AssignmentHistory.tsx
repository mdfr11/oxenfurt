// The artifact side of assignments: what was set, what was actually taken.
// This is what gets opened in front of the tutor at the next lesson, which
// is why expired rows show their real numbers instead of being hidden.
//
// A row also carries the replay affordance: opening it reveals the
// rationale and the group composition, and offers "Повторить" — the
// assignment is the thing being learned, not a one-shot task.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { AssignmentDetailResponse, AssignmentListItemDto } from '@oxenfurt/shared';
import { fetchWithAuth } from '../lib/api';
import { BottomSheet } from './BottomSheet';
import { Markdown } from './Markdown';
import { formatDate } from '../lib/dates';
import { useT } from '../lib/i18n/useT';
import { GROUP_KIND_I18N_KEY } from './assignmentHelpers';

interface AssignmentHistoryProps {
  isOpen: boolean;
  onClose: () => void;
  /** Starts a drill replay of the tapped assignment. */
  onRepeat: (assignmentId: string) => void;
}

const STATUS_KEY = {
  active: 'assignment.status_active',
  completed: 'assignment.status_completed',
  expired: 'assignment.status_expired',
} as const;

export function AssignmentHistory({ isOpen, onClose, onRepeat }: AssignmentHistoryProps) {
  const t = useT();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isPending } = useQuery({
    queryKey: ['assignments', 'history'],
    enabled: isOpen,
    queryFn: async () => {
      const res = await fetchWithAuth('/assignments');
      if (!res.ok) throw new Error('Failed to fetch assignments');
      return (await res.json()) as { assignments: AssignmentListItemDto[] };
    },
  });

  const { data: detail, isPending: isDetailPending } = useQuery({
    queryKey: ['assignments', 'detail', expandedId],
    enabled: isOpen && expandedId !== null,
    queryFn: async (): Promise<AssignmentDetailResponse> => {
      const res = await fetchWithAuth(`/assignments/${expandedId}`);
      if (!res.ok) throw new Error('Failed to fetch assignment');
      return (await res.json()) as AssignmentDetailResponse;
    },
  });

  const rows = data?.assignments ?? [];
  // The detail query outlives a collapsed row in cache, so only use it when
  // it belongs to the row that is open right now.
  const openDetail = expandedId !== null && detail?.assignment.id === expandedId ? detail : null;

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      maxHeight="75vh"
    >
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

      {isPending && rows.length === 0 ? (
        <p className="text-center text-app-hint text-xs py-8">{t('assignment.history_loading')}</p>
      ) : rows.length === 0 ? (
        <p className="text-center text-app-hint text-xs py-8">{t('assignment.history_empty')}</p>
      ) : (
        <div className="flex flex-col gap-2 pb-4">
          {rows.map((row) => {
            const expanded = expandedId === row.id;
            return (
              <div
                key={row.id}
                className={`bg-app-surface border rounded-2xl px-4 py-3 transition-colors ${
                  expanded ? 'border-app-primary/40' : 'border-app-border'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : row.id)}
                  className="w-full text-left active:opacity-70 transition-opacity"
                  aria-expanded={expanded}
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
                    {/* App locale, not device locale — this screen is opened in
                        front of the tutor and must speak the app's language. */}
                    <span>{formatDate(row.due_at, t)}</span>
                  </div>
                </button>

                {expanded && (
                  <div className="mt-3 pt-3 border-t border-app-border flex flex-col gap-3">
                    {isDetailPending || openDetail === null ? (
                      <p className="text-[11px] text-app-hint">{t('assignment.history_loading')}</p>
                    ) : (
                      <>
                        {/* Why this assignment — the agent's own words. */}
                        {openDetail.assignment.rationale !== null && (
                          <div className="text-[11px] text-app-text/85">
                            <Markdown>{openDetail.assignment.rationale}</Markdown>
                          </div>
                        )}
                        {openDetail.assignment.groups.map((group) => (
                          <div
                            key={group.label}
                            className="flex items-center gap-2.5 text-[10px]"
                          >
                            <span
                              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                group.kind === 'weak' ? 'bg-orange-400' : 'bg-app-primary'
                              }`}
                            />
                            <span className="flex-1 text-app-text/85 truncate">
                              {group.label}
                            </span>
                            <span className="text-app-hint/60 uppercase tracking-wider text-[8px] font-bold shrink-0">
                              {t(GROUP_KIND_I18N_KEY[group.kind])}
                            </span>
                            <span className="text-app-hint/70 font-black tabular-nums shrink-0">
                              {group.completed}/{group.total}
                            </span>
                          </div>
                        ))}
                        {openDetail.assignment.total > 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              onRepeat(openDetail.assignment.id);
                              onClose();
                            }}
                            className="mt-1 w-full bg-app-primary text-app-primary-text py-2.5 rounded-xl text-[12px] font-bold active:scale-95 transition-transform"
                          >
                            {t('assignment.history_repeat')}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ height: 'calc(0.5rem + var(--tg-safe-area-inset-bottom, 0px))' }} />
    </BottomSheet>
  );
}
