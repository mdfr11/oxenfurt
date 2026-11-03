// Typed-answer input with optional voice-input via Web Speech API.
// Used by the cloze / translation / listening variants in PracticeSession.
//
// The "show mic only when SpeechRecognition is available AND the user
// hasn't permanently denied mic permission" gating lives here so the
// parent doesn't have to reason about speech-API capabilities.

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Mic, MicOff } from 'lucide-react'
import type { MatchResult } from '@oxenfurt/shared'
import { ttsLangTag } from '../../lib/languages'
import {
  isSpeechRecognitionSupported,
  startRecognition,
  type RecognitionHandle,
} from '../../lib/speechRecognition'
import { getSettings } from '../../lib/settings'
import { useT } from '../../lib/i18n/useT'

interface TypedAnswerFieldProps {
  inputRef: React.RefObject<HTMLInputElement | null>
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onGiveUp: () => void
  placeholder: string
  matchResult: MatchResult | null
  /** Free-form answers (typed theory): textarea instead of input, Enter
   *  still submits. */
  multiline?: boolean
  /** Async grading in flight: disables input + submit, shows busyLabel. */
  busy?: boolean
  busyLabel?: string
}

export function TypedAnswerField({
  inputRef,
  value,
  onChange,
  onSubmit,
  onGiveUp,
  placeholder,
  matchResult,
  multiline = false,
  busy = false,
  busyLabel,
}: TypedAnswerFieldProps) {
  const t = useT()
  const isError = matchResult && matchResult.kind === 'miss'
  const isSuccess = matchResult && (matchResult.kind === 'exact' || matchResult.kind === 'close')

  const [isListening, setIsListening] = useState(false)
  const [voiceUnavailable, setVoiceUnavailable] = useState(false)
  const [voiceHint, setVoiceHint] = useState<string | null>(null)
  const recognitionRef = useRef<RecognitionHandle | null>(null)
  const speechSupported = isSpeechRecognitionSupported()

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop()
      recognitionRef.current = null
    }
  }, [])

  const toggleVoice = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (isListening) {
      recognitionRef.current?.stop()
      return
    }
    setVoiceHint(null)
    const { learningLanguage, voiceLocale } = getSettings()
    const handle = startRecognition({
      lang: ttsLangTag(learningLanguage, voiceLocale),
      onInterim: (interim) => onChange(interim),
      onResult: (transcript) => {
        onChange(transcript)
        setVoiceHint(null)
      },
      onError: (code) => {
        // Map raw codes to user-readable hints. `not-allowed` /
        // `service-not-allowed` mean mic permission denied at OS or
        // browser level — hide the mic since retrying won't help.
        // Others are transient (network, no-speech, no-audio, no-match)
        // — show a hint and let the user try again.
        if (code === 'not-allowed' || code === 'service-not-allowed') {
          setVoiceUnavailable(true)
          setVoiceHint(t('practice.voice_no_mic'))
        } else if (code === 'network') {
          setVoiceHint(t('practice.voice_no_network'))
        } else if (code === 'no-audio') {
          setVoiceHint(t('practice.voice_no_audio'))
        } else if (code === 'no-speech' || code === 'no-match') {
          setVoiceHint(t('practice.voice_no_speech'))
        } else {
          setVoiceHint(t('practice.ai_failed') + ': ' + code)
        }
      },
      onEnd: () => {
        setIsListening(false)
        recognitionRef.current = null
      },
    })
    if (handle === null) {
      setVoiceUnavailable(true)
      setVoiceHint(t('practice.voice_unavailable'))
      return
    }
    recognitionRef.current = handle
    setIsListening(true)
  }

  const showMic = speechSupported && !voiceUnavailable

  return (
    <>
      <div className={`relative ${multiline ? 'w-full max-w-[320px]' : 'w-full max-w-[240px]'}`}>
        {multiline ? (
          <textarea
            ref={(node) => {
              // Ref plumbing: the parent owns an HTMLInputElement ref for
              // focusing; a textarea satisfies the same "focus the field"
              // job. Kept permissive on purpose.
              ;(inputRef as React.MutableRefObject<HTMLElement | null>).current = node
            }}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                onSubmit()
              }
            }}
            placeholder={placeholder}
            rows={4}
            maxLength={2000}
            disabled={busy}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={`w-full text-center text-base bg-app-bg border rounded-xl py-3 px-4 focus:outline-none transition-colors resize-none ${
              isError
                ? 'border-rose-500 bg-rose-500/5'
                : isSuccess
                  ? 'border-emerald-500 bg-emerald-500/5'
                  : 'border-app-border focus:border-app-primary'
            }`}
          />
        ) : (
          <motion.input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onSubmit()
              }
            }}
            placeholder={placeholder}
            disabled={busy}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            animate={
              isError
                ? { x: [0, -10, 10, -10, 10, 0] }
                : isSuccess
                  ? { scale: [1, 1.02, 1] }
                  : {}
            }
            transition={{ duration: 0.4 }}
            className={`w-full text-center text-lg bg-app-bg border rounded-xl py-3 ${showMic ? 'pl-4 pr-12' : 'px-4'} focus:outline-none transition-colors ${
              isError
                ? 'border-rose-500 bg-rose-500/5'
                : isSuccess
                  ? 'border-emerald-500 bg-emerald-500/5'
                  : isListening
                    ? 'border-app-primary bg-app-primary/5'
                    : 'border-app-border focus:border-app-primary'
            }`}
          />
        )}
        {showMic && (
          <motion.button
            type="button"
            onClick={toggleVoice}
            animate={isListening ? { scale: [1, 1.15, 1] } : { scale: 1 }}
            transition={isListening ? { duration: 1, repeat: Infinity } : { duration: 0.2 }}
            className={`absolute right-1.5 top-1/2 -translate-y-1/2 w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
              isListening
                ? 'bg-rose-500/15 text-rose-500'
                : 'bg-app-surface text-app-hint active:scale-95'
            }`}
            aria-label={isListening ? t('practice.voice_stop') : t('practice.voice_listen')}
          >
            {isListening ? <MicOff size={16} /> : <Mic size={16} />}
          </motion.button>
        )}
      </div>
      {voiceHint && (
        <p className="w-full max-w-[280px] text-[11px] text-app-hint text-center leading-snug -mt-2">
          {voiceHint}
        </p>
      )}
      <button
        onClick={onSubmit}
        disabled={busy}
        className={`w-full ${multiline ? 'max-w-[320px]' : 'max-w-[240px]'} py-3 rounded-xl bg-app-primary text-app-primary-text font-semibold active:scale-95 transition-transform ${busy ? 'opacity-60 pointer-events-none animate-pulse' : ''}`}
      >
        {busy && busyLabel ? busyLabel : t('practice.btn_submit')}
      </button>
      {!busy && (
        <button
          onClick={onGiveUp}
          className="text-[12px] text-app-hint underline underline-offset-4 decoration-app-hint/50 active:opacity-60"
        >
          {t('practice.btn_give_up')}
        </button>
      )}
    </>
  )
}
