import { useEffect, useRef } from 'react';
import { sendData } from '@telegram-apps/sdk-react';
import { CheckCircle2 } from 'lucide-react';
import confetti from 'canvas-confetti';

interface SummaryProps {
  stats: { total: number; correct: number };
  onFinish: () => void;
  onRepeatHard: () => void;
}

export function Summary({ stats, onFinish, onRepeatHard }: SummaryProps) {
  const accuracy = stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 100;
  const wrong = stats.total - stats.correct;
  const sentRef = useRef(false)

  useEffect(() => {
    // Elegant, subtle confetti burst
    confetti({
      particleCount: 80,
      spread: 60,
      origin: { y: 0.4 },
      colors: ['#10b981', '#3b82f6', '#f59e0b'],
      disableForReducedMotion: true
    });
  }, []);

  // Send a one-line session summary back to the bot chat via sendData().
  // The Hermes agent receives it and can comment in the chat.
  useEffect(() => {
    if (sentRef.current) return
    sentRef.current = true
    try {
      const payload = JSON.stringify({
        kind: 'oxenfurt_session_summary',
        version: 1,
        total: stats.total,
        correct: stats.correct,
        wrong,
        accuracy_percent: accuracy,
        finished_at: new Date().toISOString(),
      })
      sendData(payload)
    } catch {
      // sendData is only available when the Mini App was opened inline (web_app
      // button from a bot). Not available in dev or when opened from a direct
      // link — silently skip in those cases.
    }
  }, [stats.total, stats.correct, wrong, accuracy])

  return (
    <div
      className="flex-1 flex flex-col p-6 justify-between bg-app-bg text-app-text"
      style={{
        paddingTop: `calc(1.5rem + var(--tg-safe-area-inset-top, 0px))`,
        paddingBottom: `calc(2rem + var(--tg-safe-area-inset-bottom, 0px))`,
      }}
    >
      <div className="flex-1 flex flex-col items-center justify-center text-center">
        <div className="w-20 h-20 bg-emerald-500 rounded-full flex items-center justify-center text-white shadow-lg shadow-emerald-500/20 mb-6">
          <CheckCircle2 size={40} />
        </div>
        <h1 className="text-2xl font-bold mb-2">Сессия завершена</h1>
        <p className="text-app-hint mb-10">
          Ты повторил {stats.total} {pluralize(stats.total, ['карточку', 'карточки', 'карточек'])}.
        </p>

        <div className="w-full grid grid-cols-2 gap-4 bg-app-surface border border-app-border p-6 rounded-2xl shadow-sm">
          <div className="flex flex-col">
            <span className="text-2xl font-bold">{accuracy}%</span>
            <span className="text-[10px] uppercase tracking-wider text-app-hint font-bold mt-1">Точность</span>
          </div>
          <div className="flex flex-col">
            <span className="text-2xl font-bold">{wrong}</span>
            <span className="text-[10px] uppercase tracking-wider text-app-hint font-bold mt-1">Ошибок</span>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {wrong > 0 && (
          <button 
            className="w-full bg-app-surface border border-app-border text-app-text py-4 rounded-2xl font-semibold active:scale-95 transition-transform"
            onClick={onRepeatHard}
          >
            Повторить трудные
          </button>
        )}
        <button 
          className="w-full bg-app-primary text-app-primary-text py-4 rounded-2xl font-semibold active:scale-95 transition-transform shadow-lg shadow-app-primary/20"
          onClick={onFinish}
        >
          Завершить
        </button>
      </div>
    </div>
  );
}

function pluralize(n: number, forms: [string, string, string]): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 14) return forms[2]
  const mod10 = n % 10
  if (mod10 === 1) return forms[0]
  if (mod10 >= 2 && mod10 <= 4) return forms[1]
  return forms[2]
}
