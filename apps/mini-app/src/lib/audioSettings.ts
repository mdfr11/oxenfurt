export type TtsSpeed = 'slow' | 'normal' | 'fast'

const STORAGE_KEY = 'oxenfurt_tts_speed'
const ORDER: ReadonlyArray<TtsSpeed> = ['slow', 'normal', 'fast']

const RATES: Record<TtsSpeed, number> = {
  slow: 0.75,
  normal: 0.95,
  fast: 1.2,
}

export function loadTtsSpeed(): TtsSpeed {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'slow' || v === 'normal' || v === 'fast') return v
  } catch {
    // restricted webview / SSR — ignore
  }
  return 'normal'
}

export function saveTtsSpeed(speed: TtsSpeed): void {
  try {
    localStorage.setItem(STORAGE_KEY, speed)
  } catch {
    // ignore
  }
}

export function cycleTtsSpeed(current: TtsSpeed): TtsSpeed {
  const idx = ORDER.indexOf(current)
  return ORDER[(idx + 1) % ORDER.length]!
}

export function rateForSpeed(speed: TtsSpeed): number {
  return RATES[speed]
}

export function labelForSpeed(speed: TtsSpeed): string {
  if (speed === 'slow') return 'Медленно'
  if (speed === 'fast') return 'Быстро'
  return 'Норма'
}
