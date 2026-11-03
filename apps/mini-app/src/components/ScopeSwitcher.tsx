// The scope switcher — the one new UI element of the multi-scope
// design (mockup: docs/mockups/multi-scope-mockup.html). A row of pills
// under the Home header: emoji + name + due-count badge. The active
// pill carries the scope's accent; tapping a pill switches the whole
// app context — assignment, queue, stats all follow because every
// query key and request embeds the scope.
//
// Rendered only when there is a real choice: a single configured scope
// gets no pills, exactly like the pre-scope app.

import { Check } from 'lucide-react';
import type { ScopeSummaryDto } from '@oxenfurt/shared';
import { accentColor, setScopeSlug, useScopeSlug } from '../lib/scope';

interface ScopeSwitcherProps {
  scopes: ScopeSummaryDto[];
}

export function ScopeSwitcher({ scopes }: ScopeSwitcherProps) {
  const activeSlug = useScopeSlug();
  if (scopes.length <= 1) return null;

  return (
    <div
      className="flex gap-2 overflow-x-auto -mx-6 px-6 mt-3"
      style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
    >
      {scopes.map((scope) => {
        const active = scope.slug === activeSlug;
        const accent = accentColor(scope.accent);
        return (
          <button
            key={scope.slug}
            onClick={() => setScopeSlug(scope.slug)}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-2 text-xs font-extrabold tracking-tight shrink-0 active:scale-95 transition-all ${
              active ? '' : 'bg-app-surface border-app-border text-app-hint'
            }`}
            style={
              active
                ? {
                    background: `color-mix(in srgb, ${accent} 12%, var(--app-surface))`,
                    borderColor: `color-mix(in srgb, ${accent} 45%, transparent)`,
                    color: `color-mix(in srgb, ${accent} 80%, var(--app-text))`,
                  }
                : undefined
            }
            aria-pressed={active}
          >
            {scope.emoji && <span aria-hidden>{scope.emoji}</span>}
            <span className="leading-none">{scope.title}</span>
            {scope.due_count > 0 ? (
              <span
                className="text-[10px] font-black leading-none tabular-nums rounded-full px-1.5 py-1"
                style={
                  active
                    ? { background: accent, color: '#fff' }
                    : { background: 'color-mix(in srgb, var(--app-hint) 14%, transparent)' }
                }
              >
                {scope.due_count > 99 ? '99+' : scope.due_count}
              </span>
            ) : (
              active && <Check size={12} strokeWidth={3} style={{ color: accent }} />
            )}
          </button>
        );
      })}
    </div>
  );
}
