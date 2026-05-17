// Audio surface for PracticeSession — TTS speed preference + auto-
// pronounce timer + manual replay handler. Pulled out of the main
// component so the audio lifecycle (delay, cleanup, voice selection,
// settings dependency) lives in one ~80-line file instead of being
// scattered across PracticeSession's ~1700 LOC.
//
// Pure decisions (`shouldAutoPronounce`, `pickSpeakable`) live in
// practiceHelpers.ts so they're unit-testable without rendering React.
// The hook only owns the side effects.

import { useEffect, useState } from 'react'
import type { DueCardDto } from '@oxenfurt/shared'
import {
  cycleTtsSpeed,
  loadTtsSpeed,
  rateForSpeed,
  saveTtsSpeed,
  type TtsSpeed,
} from '../lib/audioSettings'
import { getSettings } from '../lib/settings'
import { haptic } from '../lib/telegram'
import { speak, stopSpeaking } from '../lib/tts'
import type { ExerciseVariant } from '../lib/practiceMode'
import { pickSpeakable, shouldAutoPronounce } from '../components/practiceHelpers'

export interface UseCardAudioArgs {
  /** The card currently on screen, or undefined while /due is loading. */
  card: DueCardDto | undefined
  /** Exercise variant — listening always pronounces, others gate on
   *  the `autoPronounce` user setting. */
  variant: ExerciseVariant
  /** True once the back of the card is shown. We don't speak over the
   *  answer. */
  isRevealed: boolean
  /** Produce-mode flips the card so the term is the answer; speaking
   *  it on the front would spoil the prompt. */
  flipForProduce: boolean
}

export interface UseCardAudioResult {
  ttsSpeed: TtsSpeed
  cycleSpeed: () => void
  /** Manual "play again" — fires regardless of auto-pronounce setting. */
  replay: () => void
}

export function useCardAudio({
  card,
  variant,
  isRevealed,
  flipForProduce,
}: UseCardAudioArgs): UseCardAudioResult {
  const [ttsSpeed, setTtsSpeed] = useState<TtsSpeed>(() => loadTtsSpeed())

  // Auto-pronounce on the front side. Small delay so the card flip
  // animation completes before audio starts — otherwise users hear
  // playback before they see what's being pronounced.
  //
  // `card` itself is intentionally NOT in the dep list: a background
  // /due refetch hands us a fresh object with the same id, which
  // would re-trigger speech mid-card. `card?.id` is the real dep.
  useEffect(() => {
    const { autoPronounce } = getSettings()
    const speakable = pickSpeakable(card)
    if (
      !shouldAutoPronounce({
        speakable,
        variant,
        autoPronounce,
        isRevealed,
        flipForProduce,
      })
    ) {
      return undefined
    }
    const handle = setTimeout(() => {
      void speak(speakable!, { rate: rateForSpeed(ttsSpeed) })
    }, 250)
    return () => {
      clearTimeout(handle)
      stopSpeaking()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id, variant, isRevealed, ttsSpeed, flipForProduce])

  const cycleSpeed = () => {
    const next = cycleTtsSpeed(ttsSpeed)
    setTtsSpeed(next)
    saveTtsSpeed(next)
    haptic('selectionChanged')
  }

  const replay = () => {
    const text = pickSpeakable(card)
    if (text === null) return
    void speak(text, { rate: rateForSpeed(ttsSpeed) })
    haptic('selectionChanged')
  }

  return { ttsSpeed, cycleSpeed, replay }
}
