// Thin wrappers around the @telegram-apps/sdk-react surface that:
//   1. Swallow "SDK not mounted" errors (we run in vite-dev outside
//      Telegram during development, and in Storybook-like contexts the
//      SDK methods will throw on every call).
//   2. Respect the user's `hapticsEnabled` setting in one place instead
//      of having every call site re-read it.
//
// Previously each consumer (PracticeSession, Library, SettingsSheet)
// declared its own `safeHaptic` with slightly different shape. Now
// there's exactly one.

import { hapticFeedback } from '@telegram-apps/sdk-react'
import { getSettings } from './settings'

// Discriminated overloads so callers get autocomplete:
//   haptic('selectionChanged')
//   haptic('impactOccurred', 'light' | 'medium' | 'heavy' | 'rigid' | 'soft')
//   haptic('notificationOccurred', 'error' | 'success' | 'warning')
export function haptic(method: 'selectionChanged'): void
export function haptic(
  method: 'impactOccurred',
  style: Parameters<typeof hapticFeedback.impactOccurred>[0],
): void
export function haptic(
  method: 'notificationOccurred',
  type: Parameters<typeof hapticFeedback.notificationOccurred>[0],
): void
export function haptic(method: string, arg?: unknown): void {
  try {
    if (!getSettings().hapticsEnabled) return
    if (method === 'selectionChanged') {
      hapticFeedback.selectionChanged()
    } else if (method === 'impactOccurred') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hapticFeedback.impactOccurred(arg as any)
    } else if (method === 'notificationOccurred') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hapticFeedback.notificationOccurred(arg as any)
    }
  } catch {
    // SDK not initialised — fine, we're in dev or a non-Telegram host.
  }
}
