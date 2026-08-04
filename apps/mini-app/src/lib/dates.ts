// Date rendering that follows the app's selected language rather than the
// device's. The app is bilingual by design and the two do disagree — a
// Russian-speaking learner on an English phone would otherwise read "Aug 6"
// on a screen whose every other word is Russian.
//
// Lived in Stats.tsx first; lifted here when AssignmentHistory needed the
// same three lines, rather than growing a second copy that could drift.

import type { useT } from './i18n/useT'
import { getLocale } from './i18n'

/** BCP-47 tag for the *app* locale, not the device one. */
export function localeTag(): string {
  return getLocale() === 'ru' ? 'ru-RU' : 'en-US'
}

/** "Сегодня" / "Вчера" / "6 авг" — relative for the two days a learner
 *  thinks of by name, an absolute short date beyond that. */
export function formatDate(iso: string, t: ReturnType<typeof useT>): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 24 * 3600 * 1000)
  if (sameDay(d, today)) return t('stats.date_today')
  if (sameDay(d, yesterday)) return t('stats.date_yesterday')
  return d.toLocaleDateString(localeTag(), { day: 'numeric', month: 'short' })
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' })
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
}
