// Reads that sit beside `useActiveAssignment`:
//   * `useLatestAssignment` — Home's "done, but replayable" card. A finished
//     assignment disappears from `/active` the moment the last item is taken,
//     which is exactly when the learner wants to run it again, so Home keeps
//     the latest one on screen until its deadline.
//   * `useAssignmentDetail` — one assignment with its cards, for the history
//     sheet and for a drill ("Круги") session. Deliberately fetches fresh on
//     every mount: the drill/measurement decision reads `fsrs.last_review`, so
//     a cached card from an earlier round would make every repeat look like the
//     first answer of the day and write to FSRS.

import { useQuery } from '@tanstack/react-query';
import type {
  AssignmentDetailResponse,
  LatestAssignmentResponse,
} from '@oxenfurt/shared';
import { fetchWithAuth } from '../lib/api';

export const LATEST_ASSIGNMENT_KEY = ['assignments', 'latest'] as const;

export function assignmentDetailKey(assignmentId: string) {
  return ['assignments', 'detail', assignmentId] as const;
}

export function useLatestAssignment({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: LATEST_ASSIGNMENT_KEY,
    enabled,
    queryFn: async (): Promise<LatestAssignmentResponse> => {
      const res = await fetchWithAuth('/assignments/latest');
      if (!res.ok) throw new Error('Failed to fetch latest assignment');
      return (await res.json()) as LatestAssignmentResponse;
    },
    refetchInterval: 30_000,
  });
}

export function useAssignmentDetail(assignmentId: string | null) {
  return useQuery({
    queryKey: assignmentDetailKey(assignmentId ?? 'none'),
    enabled: assignmentId !== null,
    // Each round is its own mount and must see the cards as they are now.
    gcTime: 0,
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: async (): Promise<AssignmentDetailResponse> => {
      const res = await fetchWithAuth(`/assignments/${assignmentId}`);
      if (!res.ok) throw new Error('Failed to fetch assignment');
      return (await res.json()) as AssignmentDetailResponse;
    },
  });
}
