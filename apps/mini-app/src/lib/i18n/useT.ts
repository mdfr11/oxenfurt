import { useSyncExternalStore } from 'react'
import { getLocale, subscribeLocale, t, type TKey } from './index'

// React-friendly wrapper. `useT()` returns a stable `t` reference that
// re-renders consumers when `setLocale()` flips. Using
// useSyncExternalStore here so the entire tree updates atomically and
// we don't need a context provider.
export function useT(): (key: TKey, params?: Record<string, string | number>) => string {
  // Subscribe to locale; we don't actually need the value (t() reads it
  // each call), but the snapshot triggers re-render on change.
  useSyncExternalStore(subscribeLocale, getLocale, getLocale)
  return t
}
