export type PracticeMode =
  | 'mixed'
  | 'recognition'
  | 'cloze'
  | 'translation'
  | 'listening'

/**
 * Per-card rendering variant. Theory cards always degrade to `recognition`
 * — there's no term to type or audio to test against.
 */
export type ExerciseVariant = 'recognition' | 'cloze' | 'translation' | 'listening'

const STORAGE_KEY = 'oxenfurt_practice_mode'

export const PRACTICE_MODES: ReadonlyArray<PracticeMode> = [
  'mixed',
  'recognition',
  'cloze',
  'translation',
  'listening',
]

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
 * For theory cards the caller should ignore this and use `recognition`.
 */
export function pickVariantFor(mode: PracticeMode, cardId: string): ExerciseVariant {
  if (mode === 'mixed') {
    return MIXED_POOL[hashStr(cardId) % MIXED_POOL.length]!
  }
  return mode
}

function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

// Kept for backward-compat with anything still importing the old name.
export function shouldUseClozeFor(mode: PracticeMode, cardId: string): boolean {
  return pickVariantFor(mode, cardId) === 'cloze'
}
