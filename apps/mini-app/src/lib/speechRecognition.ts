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
  onstart: (() => void) | null
  onspeechstart: (() => void) | null
  onspeechend: (() => void) | null
  onaudiostart: (() => void) | null
  onaudioend: (() => void) | null
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

// Voice input is disabled across the app. Web Speech Recognition is
// unreliable in Telegram WebView on Android — the permission dialog fires
// but the recognition errors out silently with `network` / `no-speech`.
// The replacement plan is MediaRecorder → Whisper on the backend; until
// that ships, hiding the mic UI everywhere keeps the experience honest.
// Flip this back to `true` to re-enable the (broken) Web Speech path for
// debugging.
const VOICE_INPUT_ENABLED = false

export function isSpeechRecognitionSupported(): boolean {
  if (!VOICE_INPUT_ENABLED) return false
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
 *
 * Logs all lifecycle events to console with `[speech]` prefix — Telegram
 * WebView on Android often fails silently (the permission dialog appears
 * but the recognition immediately errors with `network` or `no-speech`),
 * and the DevTools log is the only way to tell what happened.
 */
export function startRecognition(opts: RecognitionOptions): RecognitionHandle | null {
  const Ctor = getCtor()
  if (Ctor === null) {
    console.warn('[speech] no SpeechRecognition constructor on window')
    return null
  }

  const rec = new Ctor()
  rec.lang = opts.lang
  rec.interimResults = opts.onInterim !== undefined
  rec.continuous = false
  rec.maxAlternatives = 1

  let finalTranscript = ''
  let sawAnyResult = false
  let sawAudio = false

  rec.onstart = () => console.info('[speech] start lang=' + rec.lang)
  rec.onaudiostart = () => { sawAudio = true; console.info('[speech] audio start') }
  rec.onaudioend = () => console.info('[speech] audio end, sawAudio=' + sawAudio)
  rec.onspeechstart = () => console.info('[speech] speech detected')
  rec.onspeechend = () => console.info('[speech] speech ended')

  rec.onresult = (event) => {
    sawAnyResult = true
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const alt = event.results[i]?.[0]
      if (alt === undefined) continue
      const text = alt.transcript
      if (i < event.results.length - 1) {
        finalTranscript += text
      } else {
        interim = text
      }
    }
    console.info('[speech] result interim="' + interim + '" final="' + finalTranscript + '"')
    if (interim !== '' && opts.onInterim) opts.onInterim(interim)
    finalTranscript = (finalTranscript + interim).trim()
  }

  rec.onerror = (e) => {
    console.warn('[speech] error: ' + e.error)
    if (opts.onError) opts.onError(e.error)
  }

  rec.onend = () => {
    console.info('[speech] end, transcript="' + finalTranscript + '" sawResult=' + sawAnyResult + ' sawAudio=' + sawAudio)
    if (finalTranscript !== '') opts.onResult(finalTranscript)
    else if (!sawAnyResult && opts.onError) {
      // Recognition stopped without ever producing a result. This is the
      // common Telegram-WebView-on-Android failure mode — give the caller
      // a synthetic error so the UI can show "не услышал, попробуй ещё".
      opts.onError(sawAudio ? 'no-match' : 'no-audio')
    }
    if (opts.onEnd) opts.onEnd()
  }

  try {
    rec.start()
  } catch (e) {
    const code = e instanceof Error ? e.name : 'start_failed'
    console.warn('[speech] start threw: ' + code)
    if (opts.onError) opts.onError(code)
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
