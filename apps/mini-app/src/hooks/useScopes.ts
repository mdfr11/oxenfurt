// The scope switcher's data + the "which scope is active" resolution.
//
// One query, shared by every surface that needs the list (Home pills).
// It also owns the bootstrap rule: until the list lands, no scope is
// active (null); once it lands, the stored slug wins if it still
// exists, otherwise the backend's default (first) scope does.

import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ScopesResponse, ScopeSummaryDto } from '@oxenfurt/shared'
import { fetchWithAuth } from '../lib/api'
import { accentColor, getScopeSlug, setScopeSlug, useScopeSlug } from '../lib/scope'

export const SCOPES_KEY = ['scopes'] as const

export function useScopes() {
  const query = useQuery({
    queryKey: SCOPES_KEY,
    queryFn: async (): Promise<ScopesResponse> => {
      const res = await fetchWithAuth('/scopes')
      if (!res.ok) throw new Error('Failed to fetch scopes')
      return (await res.json()) as ScopesResponse
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  const scopes = query.data?.scopes

  // Resolve the active slug once the list lands: the stored slug wins if
  // it still exists on the server, otherwise the backend's default
  // (first) scope does. No cache invalidation needed on a switch — every
  // scope-dependent query key embeds the slug, so new keys fetch fresh
  // and old entries simply stop matching.
  useEffect(() => {
    if (scopes === undefined || scopes.length === 0) return
    const stored = getScopeSlug()
    const resolved =
      stored !== null && scopes.some((s) => s.slug === stored) ? stored : scopes[0]!.slug
    if (resolved !== stored) setScopeSlug(resolved)
  }, [scopes])

  return query
}

export function activeScope(
  scopes: ScopeSummaryDto[] | undefined,
  slug: string | null,
): ScopeSummaryDto | null {
  if (scopes === undefined || scopes.length === 0 || slug === null) return null
  return scopes.find((s) => s.slug === slug) ?? scopes[0]!
}

/**
 * The active scope's accent hex. App.tsx sets it as the `--app-primary`
 * override on the container, so the whole interface (ring, CTA, chips,
 * progress bars) recolors with the scope without touching a single
 * component's classes.
 */
export function useScopeAccent(): string | null {
  const { data } = useScopes()
  const slug = useScopeSlug()
  const scope = activeScope(data?.scopes, slug)
  return scope === null ? null : accentColor(scope.accent)
}
