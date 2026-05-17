// Small chip below the speaker button that cycles slow → normal → fast
// TTS rates. Pure leaf — owns no state.

import { labelForSpeed, type TtsSpeed } from '../../lib/audioSettings'
import { useT } from '../../lib/i18n/useT'

interface SpeedChipProps {
  speed: TtsSpeed
  onCycle: () => void
}

export function SpeedChip({ speed, onCycle }: SpeedChipProps) {
  const t = useT()
  return (
    <button
      onClick={onCycle}
      className="text-[10px] uppercase tracking-widest font-bold px-3 py-1 rounded-full border border-app-border text-app-hint active:bg-app-surface active:scale-95 transition-all"
      aria-label={t('settings.accent_label')}
    >
      {labelForSpeed(speed)}
    </button>
  )
}
