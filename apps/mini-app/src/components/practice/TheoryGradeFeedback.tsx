// Verdict chip for a graded typed-theory answer. The fuzzy-match
// ClozeFeedback doesn't apply here — there is no "expected string" to
// diff against — so this is its own surface: verdict pill + the grader's
// one-line reason.
//
// The chip informs; the rating corridor (PracticeSession) decides which
// FSRS buttons stay tappable.

import { useT } from '../../lib/i18n/useT'

interface TheoryGradeFeedbackProps {
  verdict: 'correct' | 'close' | 'wrong'
  reason: string
}

export function TheoryGradeFeedback({ verdict, reason }: TheoryGradeFeedbackProps) {
  const t = useT()

  const pill =
    verdict === 'correct'
      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
      : verdict === 'close'
        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
        : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
  const label =
    verdict === 'correct'
      ? t('practice.theory_verdict_correct')
      : verdict === 'close'
        ? t('practice.theory_verdict_close')
        : t('practice.theory_verdict_wrong')

  return (
    <div className="flex flex-col items-center gap-1.5">
      <span className={`${pill} px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-widest`}>
        {label}
      </span>
      {reason.length > 0 && (
        <span className="text-xs text-app-hint text-center max-w-[280px] leading-snug">{reason}</span>
      )}
    </div>
  )
}
