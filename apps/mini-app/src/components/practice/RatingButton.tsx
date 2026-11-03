// Single rating button used four times in the rating row at the bottom
// of PracticeSession. `bg` / `color` are Tailwind class fragments —
// kept as props so the per-rating colour table lives at the call site
// where the FSRS rating semantics are obvious.

interface RatingButtonProps {
  label: string
  sub: string
  bg: string
  color: string
  onClick: () => void
  /** Outside the corridor allowed by an objective grade — visible but
   *  not tappable, so the four options stay where muscle memory expects
   *  them. */
  disabled?: boolean
  /** The corridor's default — ringed so one tap confirms the obvious
   *  choice. The user can still pick a different allowed rating. */
  suggested?: boolean
}

export function RatingButton({ label, sub, bg, color, onClick, disabled = false, suggested = false }: RatingButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 flex flex-col items-center justify-center gap-0.5 rounded-2xl active:scale-95 transition-all ${bg} ${
        disabled ? 'opacity-20' : ''
      } ${!disabled && suggested ? 'ring-2 ring-app-primary ring-offset-2 ring-offset-app-bg' : ''}`}
    >
      <span className={`text-[13px] font-bold ${color}`}>{label}</span>
      <span className={`text-[10px] font-medium opacity-60 uppercase ${color}`}>{sub}</span>
    </button>
  )
}
