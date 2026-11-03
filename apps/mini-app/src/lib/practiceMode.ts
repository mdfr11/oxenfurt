export type PracticeMode =
  | 'mixed'
  | 'recognition'
  | 'cloze'
  | 'translation'
  | 'listening'

/**
 * Per-card rendering variant. Theory cards get `typing` — a free-form
 * typed answer graded against the reference — in typed-answer sessions
 * and half the time in mixed ones; recognition/listening keep them as
 * flip-cards.
 */
export type ExerciseVariant = 'recognition' | 'cloze' | 'translation' | 'listening' | 'typing'

const STORAGE_KEY = 'oxenfurt_practice_mode'

export function loadPracticeMode(): PracticeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (
      v === 'mixed' ||
      v === 'recognition' ||
      v === 'cloze' ||
      v === 'translation' ||
      v === 'listening'
    ) {
      return v
    }
  } catch {
    // SSR / restricted webview — ignore.
  }
  return 'mixed'
}

export function savePracticeMode(mode: PracticeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // ignore
  }
}

// Variants that `mixed` picks from. Listening is excluded so that mixed
// sessions don't surprise the user with sudden audio they didn't opt into;
// pick `listening` explicitly for ear training.
const MIXED_POOL: ExerciseVariant[] = ['recognition', 'cloze', 'translation']

/**
 * Stable per-card variant for the given global mode. Same card id always
 * resolves to the same variant so the format doesn't flip mid-session.
 *
 * For theory cards the caller should use `pickTheoryVariant` instead.
 */
export function pickVariantFor(mode: PracticeMode, cardId: string): ExerciseVariant {
  if (mode === 'mixed') {
    return MIXED_POOL[hashStr(cardId) % MIXED_POOL.length]!
  }
  return mode
}

/**
 * Variant for theory cards. They used to degrade to recognition in every
 * mode — passive flip-through. Typed-answer sessions now keep them as
 * `typing` (type your explanation, get it graded against the reference),
 * and `mixed` alternates flip/typing hash-stably so the same card always
 * exercises the same way within a sitting. Recognition and listening
 * stay flip-cards: no term to gap-fill, no audio to test against.
 */
export function pickTheoryVariant(mode: PracticeMode, cardId: string): 'recognition' | 'typing' {
  if (mode === 'recognition' || mode === 'listening') return 'recognition'
  if (mode === 'mixed') return hashStr(cardId) % 2 === 0 ? 'recognition' : 'typing'
  return 'typing'
}

function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}
