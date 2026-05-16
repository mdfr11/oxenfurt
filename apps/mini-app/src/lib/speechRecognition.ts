// Thin wrapper around the Web Speech API. The API is exposed under either
// `SpeechRecognition` (Firefox) or `webkitSpeechRecognition` (Chromium /
// Safari / Telegram WebView on Android & iOS). We hide the prefix and the
// imperative event-handler shape behind a callback-style start/stop API.

type SpeechResultEvent = { results: ArrayLike<ArrayLike<{ transcript: string }>>; resultIndex: number }
type SpeechErrorEvent = { error: string }

interface SpeechRecognitionInstance {
  lang: string
  interimResults: boolean
  continuous: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechResultEvent) => void) | null
  onerror: ((e: SpeechErrorEvent) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function isSpeechRecognitionSupported(): boolean {
  return getCtor() !== null
}

export interface RecognitionHandle {
  /** Force-stop the current recognition session. Safe to call multiple times. */
  stop(): void
}

export interface RecognitionOptions {
  /** BCP-47 language tag, e.g. `en-US`. */
  lang: string
  /** Called with the final transcript when recognition completes. */
  onResult: (transcript: string) => void
  /** Called with interim hypotheses during dictation (for live preview). */
  onInterim?: (transcript: string) => void
  /** Called when recognition ends — either after onResult or via error. */
  onEnd?: () => void
  /** Called on hard errors (mic denied, network, etc). Followed by onEnd. */
  onError?: (code: string) => void
}

/**
 * Start a single-shot recognition. Returns a handle for explicit stop;
 * recognition also self-terminates after the user pauses speaking.
 *
 * Returns null if the browser has no Speech Recognition API.
 */
export function startRecognition(opts: RecognitionOptions): RecognitionHandle | null {
  const Ctor = getCtor()
  if (Ctor === null) return null

  const rec = new Ctor()
  rec.lang = opts.lang
  rec.interimResults = opts.onInterim !== undefined
  rec.continuous = false
  rec.maxAlternatives = 1

  let finalTranscript = ''

  rec.onresult = (event) => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const alt = event.results[i]?.[0]
      if (alt === undefined) continue
      // The Web Speech spec marks finals via `isFinal` — but our minimal type
      // doesn't model that, and in single-shot mode the last result is final
      // anyway. Concatenate everything we get and treat it as the answer.
      const text = alt.transcript
      if (i < event.results.length - 1) {
        finalTranscript += text
      } else {
        interim = text
      }
    }
    if (interim !== '' && opts.onInterim) opts.onInterim(interim)
    finalTranscript = (finalTranscript + interim).trim()
  }

  rec.onerror = (e) => {
    if (opts.onError) opts.onError(e.error)
  }

  rec.onend = () => {
    if (finalTranscript !== '') opts.onResult(finalTranscript)
    if (opts.onEnd) opts.onEnd()
  }

  try {
    rec.start()
  } catch (e) {
    // `InvalidStateError` if a previous recognition is still active. Surface
    // it through onError so the caller can recover.
    if (opts.onError) opts.onError(e instanceof Error ? e.name : 'start_failed')
    if (opts.onEnd) opts.onEnd()
    return null
  }

  return {
    stop: () => {
      try {
        rec.stop()
      } catch {
        // Already stopped — fine.
      }
    },
  }
}
