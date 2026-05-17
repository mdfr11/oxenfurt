// Five-dot bar that visualises FSRS stability buckets at a glance.
// Boundaries chosen empirically: < 2 days = brand new, 2-10 = learning,
// 10-30 = young, 30-90 = mature, > 90 = mature-stable.

interface CardStabilityIndicatorProps {
  stability: number
}

export function CardStabilityIndicator({ stability }: CardStabilityIndicatorProps) {
  let activeDots = 1
  if (stability > 90) activeDots = 5
  else if (stability > 30) activeDots = 4
  else if (stability > 10) activeDots = 3
  else if (stability > 2) activeDots = 2

  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className={`h-1 w-3 rounded-full transition-colors ${
            i <= activeDots ? 'bg-app-primary/60' : 'bg-app-hint/15'
          }`}
        />
      ))}
    </div>
  )
}
