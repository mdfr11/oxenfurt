// Tiny "which deck am I in" chip for the practice header. Practice never
// offers switching (a session always belongs to exactly one scope), but
// with more than one academy configured the header should say where the
// queue came from — otherwise a go session and an english session are
// visually identical until the first card renders.

import { activeScope, useScopes } from '../../hooks/useScopes';
import { useScopeSlug } from '../../lib/scope';

export function ScopeChip() {
  const { data } = useScopes();
  const slug = useScopeSlug();
  const scope = activeScope(data?.scopes, slug);
  if (scope === null || (data?.scopes.length ?? 0) <= 1) return null;
  return (
    <span className="flex items-center gap-1 text-app-hint bg-app-surface border border-app-border rounded-full px-2.5 py-1 text-[10px] font-bold max-w-[110px] truncate">
      {scope.emoji && <span aria-hidden>{scope.emoji}</span>}
      <span className="truncate">{scope.title}</span>
    </span>
  );
}
