import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { mainButton } from '@telegram-apps/sdk-react';
import { BookOpen, FileText } from 'lucide-react';
import type { DraftCardDto } from '@oxenfurt/shared';
import { fetchWithAuth } from '../lib/api';

interface HomeProps {
  onStart: () => void;
  onReviewDrafts: () => void;
  userFirstName?: string;
}

export function Home({ onStart, onReviewDrafts, userFirstName }: HomeProps) {
  // Number of theory cards awaiting approval. Refetched on focus so the
  // count is current when the user returns from /drafts back to Home.
  const { data: draftsData } = useQuery({
    queryKey: ['cards', 'drafts'],
    queryFn: async () => {
      const res = await fetchWithAuth('/cards/drafts');
      if (!res.ok) throw new Error('Failed to fetch drafts');
      return (await res.json()) as { cards: DraftCardDto[] };
    },
    refetchOnWindowFocus: true,
  });
  const draftCount = draftsData?.cards.length ?? 0;

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

      <div className="flex flex-col gap-3">
        {draftCount > 0 && (
          <button
            onClick={onReviewDrafts}
            className="w-full flex items-center justify-between px-5 py-4 rounded-xl border border-tg-button/30 bg-tg-button/5 active:scale-95 transition-transform"
          >
            <span className="flex items-center gap-3 text-left">
              <FileText className="text-tg-button shrink-0" size={20} />
              <span>
                <span className="font-semibold block">Theory на одобрение</span>
                <span className="text-xs text-tg-hint">
                  {draftCount} {pluralizeDrafts(draftCount)} ждёт твоего «да»
                </span>
              </span>
            </span>
            <span className="bg-tg-button text-tg-button-text text-xs font-bold rounded-full min-w-[1.5rem] h-6 px-2 flex items-center justify-center">
              {draftCount}
            </span>
          </button>
        )}

        {/* In-webview fallback for dev / non-Telegram environments. */}
        <button
          className="w-full bg-tg-button text-tg-button-text py-4 rounded-xl font-semibold text-lg active:scale-95 transition-transform shadow-md"
          onClick={onStart}
        >
          Начать сессию
        </button>
      </div>
    </div>
  );
}

function pluralizeDrafts(n: number): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 14) return 'карточек'
  const mod10 = n % 10
  if (mod10 === 1) return 'карточка'
  if (mod10 >= 2 && mod10 <= 4) return 'карточки'
  return 'карточек'
}
