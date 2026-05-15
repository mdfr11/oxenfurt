export type PracticeMode = 'recognition' | 'cloze' | 'mixed'

const STORAGE_KEY = 'oxenfurt_practice_mode'

export function loadPracticeMode(): PracticeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'recognition' || v === 'cloze' || v === 'mixed') return v
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

/**
 * Stable per-card cloze decision for `mixed` mode — same card id always
 * resolves to the same variant within (and across) sessions. Avoids the
 * surprise of re-rolling the format mid-session.
 */
export function shouldUseClozeFor(mode: PracticeMode, cardId: string): boolean {
  if (mode === 'recognition') return false
  if (mode === 'cloze') return true
  // mixed — hash uuid
  let h = 0
  for (let i = 0; i < cardId.length; i++) {
    h = ((h << 5) - h + cardId.charCodeAt(i)) | 0
  }
  return (h & 1) === 0
}
