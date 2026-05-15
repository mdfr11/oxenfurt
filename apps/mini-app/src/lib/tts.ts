/**
 * Thin wrapper around the browser's SpeechSynthesis API. Used by the
 * listening practice mode to pronounce English terms.
 *
 * Caveats:
 * - On iOS Safari (and Telegram's iOS WebView) the first .speak() call
 *   sometimes silently no-ops unless triggered by a recent user gesture.
 *   The replay button gives the user a deterministic way to hear it.
 * - getVoices() can return [] on first call; voices populate
 *   asynchronously, so we wait for the `voiceschanged` event once.
 */

export type TtsSupport = 'ready' | 'pending' | 'unsupported'

export function ttsSupport(): TtsSupport {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return 'unsupported'
  }
  const voices = window.speechSynthesis.getVoices()
  if (voices.length === 0) return 'pending'
  return voices.some((v) => v.lang.toLowerCase().startsWith('en')) ? 'ready' : 'unsupported'
}

/**
 * Resolves with the first English voice that's available, or `null` if no
 * English voice can be loaded after `timeoutMs`.
 */
export async function getEnglishVoice(timeoutMs = 800): Promise<SpeechSynthesisVoice | null> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null

  const pick = (voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null => {
    if (voices.length === 0) return null
    return (
      voices.find((v) => v.lang.toLowerCase() === 'en-us') ??
      voices.find((v) => v.lang.toLowerCase().startsWith('en-')) ??
      voices.find((v) => v.lang.toLowerCase().startsWith('en')) ??
      null
    )
  }

  const immediate = pick(window.speechSynthesis.getVoices())
  if (immediate) return immediate

  return await new Promise<SpeechSynthesisVoice | null>((resolve) => {
    let resolved = false
    const handler = () => {
      if (resolved) return
      const v = pick(window.speechSynthesis.getVoices())
      if (v) {
        resolved = true
        window.speechSynthesis.removeEventListener('voiceschanged', handler)
        resolve(v)
      }
    }
    window.speechSynthesis.addEventListener('voiceschanged', handler)
    setTimeout(() => {
      if (!resolved) {
        resolved = true
        window.speechSynthesis.removeEventListener('voiceschanged', handler)
        resolve(pick(window.speechSynthesis.getVoices()))
      }
    }, timeoutMs)
  })
}

export async function speak(text: string, opts: { rate?: number } = {}): Promise<void> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
  // Cancel anything in flight — avoid stacked utterances on rapid card flips.
  window.speechSynthesis.cancel()
  const voice = await getEnglishVoice()
  const utt = new SpeechSynthesisUtterance(text)
  utt.lang = voice?.lang ?? 'en-US'
  if (voice) utt.voice = voice
  utt.rate = opts.rate ?? 0.95
  window.speechSynthesis.speak(utt)
}

/** Cancel any in-flight or queued speech — call on unmount. */
export function stopSpeaking(): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
  window.speechSynthesis.cancel()
}
