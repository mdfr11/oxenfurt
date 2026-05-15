import { useEffect } from 'react';
import { mainButton } from '@telegram-apps/sdk-react';
import { BookOpen } from 'lucide-react';

interface HomeProps {
  onStart: () => void;
  userFirstName?: string;
}

export function Home({ onStart, userFirstName }: HomeProps) {
  // Wire the Telegram MainButton to "Start session". When the SDK isn't
  // mounted (dev outside Telegram) we fall back to the in-webview button below.
  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    try {
      mainButton.setParams({ text: 'Начать сессию', isVisible: true, isEnabled: true })
      unsubscribe = mainButton.onClick(onStart)
    } catch {
      // SDK not mounted — fine, the in-webview button still works
    }
    return () => {
      try {
        unsubscribe?.()
        mainButton.setParams({ isVisible: false })
      } catch {
        // ditto
      }
    }
  }, [onStart])

  return (
    <div
      className="flex-1 flex flex-col p-6 justify-between bg-tg-bg"
      style={{
        paddingTop: `calc(1.5rem + var(--tg-safe-area-inset-top, 0px))`,
        paddingBottom: `calc(2rem + var(--tg-safe-area-inset-bottom, 0px))`,
      }}
    >
      <div className="flex-1 flex flex-col items-center justify-center">
        <div className="w-24 h-24 bg-tg-button rounded-[2rem] flex items-center justify-center text-tg-button-text shadow-lg mb-8">
          <BookOpen size={48} />
        </div>
        <h1 className="text-3xl font-bold mb-2">Oxenfurt</h1>
        <p className="text-tg-hint text-center max-w-[280px]">
          {userFirstName ? `Привет, ${userFirstName}! ` : ''}
          Твои карточки готовы к повторению.
        </p>
      </div>

      {/* In-webview fallback for dev / non-Telegram environments. */}
      <button 
        className="w-full bg-tg-button text-tg-button-text py-4 rounded-xl font-semibold text-lg active:scale-95 transition-transform shadow-md"
        onClick={onStart}
      >
        Начать сессию
      </button>
    </div>
  );
}
