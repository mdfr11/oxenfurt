// Feedback chip rendered after a typed answer is submitted. Three
// states match matchAnswer's verdict ladder:
//   exact   — green pill, no extra context
//   close   — amber pill with what the user typed
//   miss    — rose pill with what the user typed + optional AI-grade
//             escape hatch (only when the user opted into AI grading)

import type { MatchResult } from '@oxenfurt/shared'
import { getSettings } from '../../lib/settings'
import { useT } from '../../lib/i18n/useT'
import { SemanticGradeButton } from './SemanticGradeButton'

interface ClozeFeedbackProps {
  result: MatchResult
  typedAnswer: string
  expected?: string
  hint?: string
}

export function ClozeFeedback({ result, typedAnswer, expected, hint }: ClozeFeedbackProps) {
  const t = useT()
  if (result.kind === 'exact') {
    return (
      <span className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-widest">
        {t('practice.feedback_exact')}
      </span>
    )
  }
  if (result.kind === 'close') {
    return (
      <div className="flex flex-col items-center gap-1.5">
        <span className="bg-amber-500/15 text-amber-600 dark:text-amber-400 px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-widest">
          {t('practice.feedback_close')}
        </span>
        <span className="text-xs text-app-hint">
          {t('practice.feedback_you_wrote', { answer: typedAnswer.trim() || '—' })}
        </span>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center gap-1.5">
      <span className="bg-rose-500/15 text-rose-600 dark:text-rose-400 px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-widest">
        {t('practice.feedback_miss')}
      </span>
      {typedAnswer.trim() && (
        <span className="text-xs text-app-hint">
          {t('practice.feedback_you_wrote', { answer: typedAnswer.trim() })}
        </span>
      )}
      {expected !== undefined && typedAnswer.trim() && getSettings().aiGradingEnabled && (
        <SemanticGradeButton userAnswer={typedAnswer.trim()} expected={expected} hint={hint} />
      )}
    </div>
  )
}
