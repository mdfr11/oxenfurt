/**
 * Server-side TTS via the backend `/tts` proxy. We used to call
 * `window.speechSynthesis.speak()` directly, but on Android phones without
 * a system English voice installed (the default in many locales) the call
 * silently produced nothing. Going through the server gives us:
 *
 *   - Consistent voice quality across iOS / Android / desktop
 *   - No dependency on system TTS engines or installed language packs
 *   - Browser HTTP cache reuses audio across replays of the same term
 *
 * The audio is fetched with the user's JWT (so the proxy is only available
 * to the logged-in owner), then decoded from a Blob URL and played via a
 * standard HTMLAudioElement.
 */

import { API_BASE, getToken } from './api'

let activeAudio: HTMLAudioElement | null = null
let activeUrl: string | null = null

function disposeActive(): void {
  if (activeAudio) {
    try {
      activeAudio.pause()
    } catch {
      // ignore
    }
    activeAudio = null
  }
  if (activeUrl) {
    URL.revokeObjectURL(activeUrl)
    activeUrl = null
  }
}

export async function speak(text: string, opts: { rate?: number } = {}): Promise<void> {
  if (typeof window === 'undefined') return
  const trimmed = text.trim()
  if (trimmed.length === 0) return

  // Cancel anything in flight — back-to-back card flips shouldn't stack.
  disposeActive()

  const token = getToken()
  if (!token) {
    console.warn('[tts] no JWT, cannot fetch audio')
    return
  }

  let blob: Blob
  try {
    const res = await fetch(`${API_BASE}/tts?text=${encodeURIComponent(trimmed)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      console.warn('[tts] backend returned', res.status, await res.text().catch(() => ''))
      return
    }
    blob = await res.blob()
  } catch (err) {
    console.warn('[tts] fetch failed', err)
    return
  }

  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  audio.playbackRate = opts.rate ?? 0.95
  activeAudio = audio
  activeUrl = url

  audio.addEventListener('ended', () => {
    if (activeAudio === audio) disposeActive()
  }, { once: true })
  audio.addEventListener('error', (e) => {
    console.warn('[tts] audio element error', e)
    if (activeAudio === audio) disposeActive()
  }, { once: true })

  try {
    await audio.play()
  } catch (err) {
    // NotAllowedError happens when the play wasn't triggered by a recent
    // user gesture. Should be rare after primeSpeech() has unlocked, but
    // log it so we can spot devices where it still bites.
    console.warn('[tts] audio.play() rejected', err)
    if (activeAudio === audio) disposeActive()
  }
}

/** Cancel any in-flight or queued audio — call on unmount. */
export function stopSpeaking(): void {
  disposeActive()
}

/**
 * Call once from a user-gesture handler (e.g. "Начать сессию" onClick) to
 * unlock the HTMLAudio playback path on mobile browsers. Same idea as the
 * Web Audio AudioContext priming — Android Chrome / WebView gates the
 * first .play() unless it's been preceded by a user gesture in the page
 * lifecycle.
 *
 * The trick: kick off a play() on a tiny silent data-URI. Browsers count
 * the gesture and unlock the path; subsequent plays from non-gesture
 * code (like a setTimeout 250ms after card mount) then work.
 */
export function primeSpeech(): void {
  if (typeof window === 'undefined') return
  try {
    const a = new Audio(
      // 0.1s of WAV silence. Tiny payload; engines treat it as a real
      // playback and consider the audio path unlocked for the page.
      'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAVFYAAFRWAAABAAgAZGF0YQAAAAA=',
    )
    a.volume = 0
    void a.play().catch(() => {
      // best-effort warmup; if it fails the explicit replay button still
      // works since that's also a user gesture.
    })
  } catch {
    // ignore
  }
}

// --- Legacy exports kept for compatibility with callers (no-op now). ---

/** No-op — we no longer rely on SpeechSynthesis. Kept so existing imports
 *  don't break. Always reports 'ready' since the backend speaks. */
export function ttsSupport(): 'ready' {
  return 'ready'
}

/** No-op — kept for backwards compatibility. */
export async function getEnglishVoice(): Promise<null> {
  return null
}
