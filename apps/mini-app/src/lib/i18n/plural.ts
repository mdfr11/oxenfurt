// Russian-style plural picker.
//
// Russian (and several other Slavic languages) have THREE grammatical
// number forms: one (1, 21, 101), few (2-4, 22-24), many (5-20, 0).
// English collapses to two; the locale file repeats the same string
// for `_one`/`_few`/`_many` when the language doesn't distinguish (the
// en.ts side already does this for every plural key).
//
// Pure return — caller wraps in `t()` so the generic TKey constraint
// keeps callers honest. Replaces five hand-rolled copies that used to
// live in Home, Library, Stats, Summary, and AnswersScreen.

import type { TKey } from './index'

export function plurKey<A extends TKey, B extends TKey, C extends TKey>(
  n: number,
  one: A,
  few: B,
  many: C,
): A | B | C {
  const abs = Math.abs(n)
  const mod10 = abs % 10
  const mod100 = abs % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}
