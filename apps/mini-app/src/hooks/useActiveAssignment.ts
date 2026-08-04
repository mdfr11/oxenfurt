// Single source of truth for "is there an assignment right now". Home and
// PracticeSession both read it; the 30 s refetch matches the /stats/today
// cadence already used on Home so the two never disagree for long.

import { useQuery } from '@tanstack/react-query';
import type { ActiveAssignmentResponse } from '@oxenfurt/shared';
import { fetchWithAuth } from '../lib/api';

export const ACTIVE_ASSIGNMENT_KEY = ['assignments', 'active'] as const;

export interface UseActiveAssignmentOptions {
  /** Off for a free practice session, which must not read the assignment
   *  at all. Defaults to on — Home always wants it. */
  enabled?: boolean;
}

export function useActiveAssignment({ enabled = true }: UseActiveAssignmentOptions = {}) {
  return useQuery({
    queryKey: ACTIVE_ASSIGNMENT_KEY,
    enabled,
    queryFn: async (): Promise<ActiveAssignmentResponse> => {
      const res = await fetchWithAuth('/assignments/active');
      if (!res.ok) throw new Error('Failed to fetch assignment');
      return (await res.json()) as ActiveAssignmentResponse;
    },
    refetchInterval: 30_000,
  });
}
