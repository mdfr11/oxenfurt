/**
 * TTS playback with three fallbacks:
 *
 *   1. Server-side TTS via `/api/tts`, decoded and played through Web Audio
 *      (AudioContext + AudioBufferSourceNode). This is the path we want
 *      on Android: the UI sound effects already use Web Audio successfully
 *      there, while HTMLAudio + blob URLs proved flaky in the Telegram
 *      Android WebView (Audio.play() either rejects or no-ops with no
 *      audible output).
 *
 *   2. Server-side TTS via HTMLAudio. If Web Audio decode fails (some
 *      older WebViews struggle with MP3 framing), we try the simpler
 *      `<audio>` element route.
 *
 *   3. Browser SpeechSynthesis. Last-resort fallback for the case where
 *      the server proxy is unreachable. Works on most desktops; on Android
 *      it depends on a system English voice that may not be installed,
 *      so don't rely on it.
 *
 * Errors at each layer log to console with the `[tts]` prefix so DevTools
 * shows exactly which path was attempted and why it failed.
 */

import { API_BASE, getToken } from './api'
import { getSettings } from './settings'
import { ttsLangTag } from './languages'

// --- Dedicated AudioContext just for TTS playback ---
//
// We deliberately do NOT reuse lib/audio.ts's context because that one is
// gated by the user's "soundEnabled" setting (which controls UI clicks,
// not pronunciation). TTS has its own meaning and its own enable state.
let ttsCtx: AudioContext | null = null

function getTtsContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ttsCtx) {
    const Ctor =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (Ctor) ttsCtx = new Ctor()
  }
  if (ttsCtx && ttsCtx.state === 'suspended') {
    void ttsCtx.resume().catch(() => {})
  }
  return ttsCtx
}

let activeSource: AudioBufferSourceNode | null = null
let activeAudio: HTMLAudioElement | null = null
let activeUrl: string | null = null

function disposeActive(): void {
  if (activeSource) {
    try {
      activeSource.stop()
    } catch {
      // ignore
    }
    activeSource = null
  }
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

  disposeActive()

  // Compute the BCP-47 tag from the learning language. English honours the
  // user's accent preference (US/UK); other languages have a canonical
  // region picked in lib/languages.ts.
  const { learningLanguage, voiceLocale } = getSettings()
  const langTag = ttsLangTag(learningLanguage, voiceLocale)

  const buf = await fetchTtsBuffer(trimmed, langTag)
  if (buf !== null) {
    // Path 1: Web Audio decode + play. The canonical mobile-friendly path.
    if (await tryPlayWebAudio(buf, opts)) return
    // Path 2: HTMLAudio fallback for desktops where Web Audio decoding
    // might have failed for some reason.
    if (await tryPlayHtmlAudio(buf, opts)) return
  }

  // Path 3: ultimate fallback — system synthesizer.
  trySpeakSystem(trimmed, langTag, opts)
}

async function fetchTtsBuffer(text: string, lang: string): Promise<ArrayBuffer | null> {
  const token = getToken()
  if (!token) {
    console.warn('[tts] no JWT, skipping server TTS')
    return null
  }
  try {
    const res = await fetch(`${API_BASE}/tts?text=${encodeURIComponent(text)}&lang=${lang}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      console.warn('[tts] server returned', res.status)
      return null
    }
    const buf = await res.arrayBuffer()
    if (buf.byteLength === 0) {
      console.warn('[tts] server returned empty body')
      return null
    }
    return buf
  } catch (err) {
    console.warn('[tts] server fetch failed', err)
    return null
  }
}

async function tryPlayWebAudio(buffer: ArrayBuffer, opts: { rate?: number }): Promise<boolean> {
  const ctx = getTtsContext()
  if (!ctx) {
    console.warn('[tts] no AudioContext, skipping Web Audio path')
    return false
  }
  let decoded: AudioBuffer
  try {
    // decodeAudioData mutates its input ArrayBuffer in some implementations;
    // copy before decoding so the buffer remains usable for the HTMLAudio
    // fallback if needed.
    const copy = buffer.slice(0)
    decoded = await ctx.decodeAudioData(copy)
  } catch (err) {
    console.warn('[tts] decodeAudioData failed', err)
    return false
  }
  try {
    const source = ctx.createBufferSource()
    source.buffer = decoded
    source.playbackRate.value = opts.rate ?? 0.95
    source.connect(ctx.destination)
    activeSource = source
    source.addEventListener('ended', () => {
      if (activeSource === source) activeSource = null
    })
    source.start(0)
    console.info('[tts] playing via Web Audio')
    return true
  } catch (err) {
    console.warn('[tts] Web Audio start failed', err)
    return false
  }
}

async function tryPlayHtmlAudio(buffer: ArrayBuffer, opts: { rate?: number }): Promise<boolean> {
  const blob = new Blob([buffer], { type: 'audio/mpeg' })
  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  audio.playbackRate = opts.rate ?? 0.95
  activeAudio = audio
  activeUrl = url

  audio.addEventListener(
    'ended',
    () => {
      if (activeAudio === audio) disposeActive()
    },
    { once: true },
  )
  audio.addEventListener(
    'error',
    (e) => {
      console.warn('[tts] audio element error', e)
      if (activeAudio === audio) disposeActive()
    },
    { once: true },
  )

  try {
    await audio.play()
    console.info('[tts] playing via HTMLAudio')
    return true
  } catch (err) {
    console.warn('[tts] audio.play() rejected', err)
    if (activeAudio === audio) disposeActive()
    return false
  }
}

function trySpeakSystem(text: string, lang: string, opts: { rate?: number }): void {
  if (!('speechSynthesis' in window)) {
    console.warn('[tts] SpeechSynthesis not available — no further fallback')
    return
  }
  try {
    const sys = window.speechSynthesis
    sys.cancel()
    const utt = new SpeechSynthesisUtterance(text)
    utt.lang = lang
    utt.rate = opts.rate ?? 0.95
    utt.onstart = () => console.info('[tts] fallback: SpeechSynthesis speaking')
    utt.onerror = (e) => console.warn('[tts] fallback SpeechSynthesis error', e.error)
    sys.speak(utt)
  } catch (err) {
    console.warn('[tts] SpeechSynthesis threw', err)
  }
}

/** Cancel any in-flight or queued audio — call on unmount. */
export function stopSpeaking(): void {
  disposeActive()
}

/**
 * Call from a user-gesture handler (e.g. "Начать сессию" onClick) to
 * unlock both audio playback paths on mobile browsers. Plays a tiny
 * silent buffer through Web Audio AND fires a no-op HTMLAudio play —
 * each path is gated separately by the browser, so we cover both.
 */
export function primeSpeech(): void {
  if (typeof window === 'undefined') return

  // Unlock Web Audio context.
  const ctx = getTtsContext()
  if (ctx && ctx.state === 'suspended') {
    void ctx.resume().catch(() => {})
  }

  // Unlock HTMLAudio path with a 100ms silent data URI.
  try {
    const a = new Audio(
      'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAVFYAAFRWAAABAAgAZGF0YQAAAAA=',
    )
    a.volume = 0
    void a.play().catch(() => {})
  } catch {
    // ignore
  }
}

// --- Legacy exports kept for compatibility ---

export function ttsSupport(): 'ready' {
  return 'ready'
}

export async function getEnglishVoice(): Promise<null> {
  return null
}
