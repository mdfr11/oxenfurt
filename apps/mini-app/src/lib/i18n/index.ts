// Minimal i18n. Two locales (ru, en), keys are flat dot-prefixed strings,
// `t(key, params)` returns a templated string. Auto-detects from Telegram
// initData; user can override in Settings. About 50 lines of runtime
// because we explicitly want to avoid the react-i18next dependency for a
// project that has no plans to add a third language.
//
// Pluralisation: not built in. For Russian we already had a `pluralize`
// helper; for English most cases collapse to `1 X / N Xs`. When a string
// needs both, use `t('foo.count_other', { n })` + a sibling `count_one`
// and pick at the call site.

import { ru } from './locales/ru'
import { en } from './locales/en'

export type Locale = 'ru' | 'en'

const dictionaries: Record<Locale, Record<string, string>> = { ru, en } as const

// `ru` is the source of truth for which keys exist. Anything missing in
// `en` falls through to `ru` (better to show Russian than a key string).
export type TKey = keyof typeof ru

const subscribers = new Set<() => void>()
let current: Locale = 'en'

export function getLocale(): Locale {
  return current
}

export function setLocale(l: Locale): void {
  if (l === current) return
  current = l
  for (const cb of subscribers) cb()
}

export function subscribeLocale(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/**
 * Translate a key. Falls back to `ru` for missing keys, then to the key
 * itself. `params` interpolates `{name}` placeholders.
 */
export function t(key: TKey, params?: Record<string, string | number>): string {
  const dict = dictionaries[current]
  let s = dict[key] ?? ru[key] ?? String(key)
  if (params !== undefined) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, String(v))
    }
  }
  return s
}

/**
 * Best-effort detection of a Telegram-provided locale. Maps any code
 * starting with 'ru' to Russian, anything else to English (we have
 * exactly two UI languages — international users get English regardless
 * of their actual country).
 */
export function detectLocale(languageCode: string | undefined): Locale {
  if (typeof languageCode === 'string' && languageCode.toLowerCase().startsWith('ru')) {
    return 'ru'
  }
  return 'en'
}
