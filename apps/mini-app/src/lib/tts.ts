/**
 * Thin wrapper around the browser's SpeechSynthesis API. Used by the
 * listening practice mode to pronounce English terms.
 *
 * Known browser quirks this module accommodates:
 *
 * - **Voices load asynchronously**. `getVoices()` returns [] on first call;
 *   voices become available after a `voiceschanged` event. Most platforms
 *   take <100ms but Android can take 1-2 seconds on the very first call
 *   after the WebView starts.
 *
 * - **User-gesture requirement**. Mobile browsers (notably Android Chrome /
 *   WebView) will silently drop a speak() call that's not invoked from a
 *   user gesture handler — including ones fired from a setTimeout shortly
 *   after a tap. We expose `primeSpeech()` so PracticeSession can prime the
 *   synth from inside the tap handler that opened the session.
 *
 * - **No English voice installed**. On phones without an English TTS pack
 *   the synth falls back to the system default (often the OS language
 *   like Russian), which mangles English pronunciation. We log a warning
 *   and try anyway — that's still better than silence.
 */

let voicesPromise: Promise<SpeechSynthesisVoice[]> | null = null
let primed = false

function hasSynth(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (voicesPromise) return voicesPromise
  if (!hasSynth()) {
    voicesPromise = Promise.resolve([])
    return voicesPromise
  }
  voicesPromise = new Promise((resolve) => {
    const sys = window.speechSynthesis
    const immediate = sys.getVoices()
    if (immediate.length > 0) {
      resolve(immediate)
      return
    }
    let resolved = false
    const finish = (voices: SpeechSynthesisVoice[]) => {
      if (resolved) return
      resolved = true
      sys.removeEventListener('voiceschanged', handler)
      resolve(voices)
    }
    const handler = () => finish(sys.getVoices())
    sys.addEventListener('voiceschanged', handler)
    // Give Android a generous window — voices arrive 1-2s after init.
    setTimeout(() => finish(sys.getVoices()), 3000)
  })
  return voicesPromise
}

export type TtsSupport = 'ready' | 'pending' | 'unsupported'

export function ttsSupport(): TtsSupport {
  if (!hasSynth()) return 'unsupported'
  const voices = window.speechSynthesis.getVoices()
  if (voices.length === 0) return 'pending'
  return voices.some((v) => v.lang.toLowerCase().startsWith('en')) ? 'ready' : 'unsupported'
}

export async function getEnglishVoice(): Promise<SpeechSynthesisVoice | null> {
  if (!hasSynth()) return null
  const voices = await loadVoices()
  if (voices.length === 0) return null
  return (
    voices.find((v) => v.lang.toLowerCase() === 'en-us') ??
    voices.find((v) => v.lang.toLowerCase().startsWith('en-')) ??
    voices.find((v) => v.lang.toLowerCase().startsWith('en')) ??
    null
  )
}

/**
 * Call once from a user-gesture handler (e.g. inside onClick) to unlock
 * speechSynthesis on mobile browsers that gate it. The "warmup" utterance
 * is empty so the user hears nothing, but the synth engine considers
 * itself permitted for subsequent calls in the same page session.
 *
 * Safe to call repeatedly — only the first call actually runs the warmup.
 */
export function primeSpeech(): void {
  if (!hasSynth() || primed) return
  primed = true
  try {
    const sys = window.speechSynthesis
    const warmup = new SpeechSynthesisUtterance(' ')
    warmup.volume = 0
    warmup.rate = 1
    sys.speak(warmup)
  } catch {
    // ignore — best-effort warmup
  }
}

export async function speak(text: string, opts: { rate?: number } = {}): Promise<void> {
  if (!hasSynth()) {
    console.warn('[tts] speechSynthesis not available')
    return
  }
  const sys = window.speechSynthesis
  // Stop anything in flight — avoid stacked utterances on fast card flips.
  sys.cancel()

  const voice = await getEnglishVoice()
  if (!voice) {
    console.warn(
      '[tts] no English voice installed on this device — falling back to system default with lang=en-US. ' +
        'Pronunciation will be incorrect; install an English TTS voice in system settings to fix.',
    )
  }
  const utt = new SpeechSynthesisUtterance(text)
  utt.lang = voice?.lang ?? 'en-US'
  if (voice) utt.voice = voice
  utt.rate = opts.rate ?? 0.95
  utt.onerror = (e) => {
    console.warn('[tts] speak error', e.error)
  }
  utt.onstart = () => {
    console.info('[tts] speaking:', text)
  }
  sys.speak(utt)

  // Some Chrome variants bug out and never speak unless re-prodded — a
  // documented workaround is to pause+resume the synth right after.
  // Cheap, no audible effect when the synth is fine.
  try {
    sys.pause()
    sys.resume()
  } catch {
    // ignore
  }
}

/** Cancel any in-flight or queued speech — call on unmount. */
export function stopSpeaking(): void {
  if (!hasSynth()) return
  window.speechSynthesis.cancel()
}
