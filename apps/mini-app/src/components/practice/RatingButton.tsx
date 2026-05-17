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
}

export function RatingButton({ label, sub, bg, color, onClick }: RatingButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex flex-col items-center justify-center gap-0.5 rounded-2xl active:scale-95 transition-transform ${bg}`}
    >
      <span className={`text-[13px] font-bold ${color}`}>{label}</span>
      <span className={`text-[10px] font-medium opacity-60 uppercase ${color}`}>{sub}</span>
    </button>
  )
}
