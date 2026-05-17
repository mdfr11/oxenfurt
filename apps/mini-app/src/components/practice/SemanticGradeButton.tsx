// Opt-in second opinion on a typed-answer miss. The character-level
// fuzzy match in matchAnswer() is fast but blind to synonyms or
// paraphrase ("I want to leave" vs "I want to go away") — this button
// asks the configured LLM for a semantic verdict. Fires on demand,
// only on miss, so the cost is tiny (~$0.0002 per click on Haiku-class
// models). Operator opts in via settings.aiGradingEnabled; backend
// returns 503 when LLM env isn't configured.

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Sparkles } from 'lucide-react'
import { fetchWithAuth } from '../../lib/api'
import { useT } from '../../lib/i18n/useT'

interface SemanticGradeButtonProps {
  userAnswer: string
  expected: string
  hint?: string
}

type GradeState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; verdict: 'correct' | 'close' | 'wrong'; reason: string }
  | { kind: 'error'; message: string }

export function SemanticGradeButton({ userAnswer, expected, hint }: SemanticGradeButtonProps) {
  const t = useT()
  const [state, setState] = useState<GradeState>({ kind: 'idle' })

  const check = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setState({ kind: 'loading' })
    try {
      const res = await fetchWithAuth('/grade', {
        method: 'POST',
        body: JSON.stringify({ user_answer: userAnswer, expected, hint }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        if (body.error === 'llm_not_configured') {
          setState({ kind: 'error', message: t('practice.ai_not_configured') })
        } else {
          setState({ kind: 'error', message: t('practice.ai_failed') })
        }
        return
      }
      const data = (await res.json()) as { verdict: 'correct' | 'close' | 'wrong'; reason: string }
      setState({ kind: 'done', ...data })
    } catch {
      setState({ kind: 'error', message: t('practice.ai_no_network') })
    }
  }

  if (state.kind === 'idle') {
    return (
      <button
        onClick={check}
        className="flex items-center gap-1.5 text-[11px] text-app-primary font-bold active:opacity-60 transition-opacity mt-1"
      >
        <div className="w-5 h-5 rounded-full bg-amber-500/10 text-amber-600 flex items-center justify-center">
          <Sparkles size={10} fill="currentColor" />
        </div>
        <span>{t('practice.btn_ai_grade')}</span>
      </button>
    )
  }
  if (state.kind === 'loading') {
    return (
      <div className="flex items-center gap-2 mt-1">
        <motion.div
          animate={{ scale: [1, 1.2, 1], opacity: [0.5, 1, 0.5] }}
          transition={{ duration: 1.5, repeat: Infinity }}
          className="text-amber-500"
        >
          <Sparkles size={14} fill="currentColor" />
        </motion.div>
        <span className="text-[11px] text-app-hint italic font-medium text-center">
          {t('practice.ai_thinking')}
        </span>
      </div>
    )
  }
  if (state.kind === 'error') {
    return <span className="text-[11px] text-app-hint">{state.message}</span>
  }
  const colorClass =
    state.verdict === 'correct'
      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
      : state.verdict === 'close'
        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
        : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
  const verdictLabel =
    state.verdict === 'correct'
      ? t('practice.ai_verdict_correct')
      : state.verdict === 'close'
        ? t('practice.ai_verdict_close')
        : t('practice.ai_verdict_wrong')
  return (
    <div className="flex flex-col items-center gap-1 max-w-[260px]">
      <span
        className={`px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-widest ${colorClass}`}
      >
        {verdictLabel}
      </span>
      <span className="text-[11px] text-app-hint text-center leading-snug">{state.reason}</span>
    </div>
  )
}
