import { useEffect, useState } from 'react';
import { useRawInitData, useLaunchParams, retrieveLaunchParams } from '@telegram-apps/sdk-react';
import { Spinner } from '@telegram-apps/telegram-ui';
import { loginWithTelegram, setToken } from './lib/api';
import { PracticeSession } from './components/PracticeSession';
import { Home } from './components/Home';
import { Summary } from './components/Summary';
import { Library } from './components/Library';
import { loadPracticeMode, type PracticeMode } from './lib/practiceMode';

type Screen = 'home' | 'practice' | 'summary' | 'loading' | 'library';

interface SessionStats {
  total: number;
  correct: number;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [stats, setStats] = useState<SessionStats>({ total: 0, correct: 0 });
  const [practiceMode, setPracticeMode] = useState<PracticeMode>(() => loadPracticeMode());
  const initDataRaw = useRawInitData();
  const launchParams = useLaunchParams();

  const userFirstName: string | undefined =
    launchParams.tgWebAppData?.user?.first_name

  useEffect(() => {
    let cancelled = false
    async function auth() {
      const API_BASE = import.meta.env.VITE_API_URL ?? (typeof window !== 'undefined' ? window.location.origin + '/api' : 'http://localhost:3000');

      // Dev path: backend issues a dev token without HMAC validation.
      // Production: real Telegram initData → /auth/session.
      if (import.meta.env.DEV) {
        try {
          const res = await fetch(`${API_BASE}/auth/dev-token`);
          if (res.ok) {
            const data = (await res.json()) as { token: string };
            setToken(data.token);
          } else {
            console.warn('Dev token endpoint returned', res.status, '— continuing without auth.');
          }
        } catch (err) {
          console.error('Dev auth failed', err);
        }
        if (!cancelled) setScreen('home');
        return;
      }

      const data = initDataRaw ?? safeRetrieveInitData()
      if (data === undefined) {
        if (!cancelled) setScreen('home');
        return
      }

      try {
        await loginWithTelegram(data);
        if (!cancelled) setScreen('home');
      } catch (err) {
        console.error('Auth failed', err);
        if (!cancelled) setScreen('home');
      }
    }
    auth();
    return () => {
      cancelled = true
    }
  }, [initDataRaw]);

  return (
    <div className="app-container">
      {screen === 'loading' && (
        <div className="flex-1 flex items-center justify-center">
          <Spinner size="l" />
        </div>
      )}
      {screen === 'practice' && (
        <PracticeSession
          mode={practiceMode}
          onComplete={(total, correct) => {
            setStats({ total, correct });
            setScreen('summary');
          }}
          onExit={() => setScreen('home')}
        />
      )}
      {screen === 'summary' && (
        <Summary
          stats={stats}
          onFinish={() => setScreen('home')}
          onRepeatHard={() => setScreen('practice')}
        />
      )}
      {screen === 'library' && (
        <Library onExit={() => setScreen('home')} />
      )}
      {screen === 'home' && (
        <Home
          onStart={(mode) => {
            setPracticeMode(mode);
            setScreen('practice');
          }}
          onOpenLibrary={() => setScreen('library')}
          userFirstName={userFirstName}
        />
      )}
    </div>
  );
}


function safeRetrieveInitData(): string | undefined {
  try {
    const params = retrieveLaunchParams()
    return params.tgWebAppData ? new URLSearchParams(Object.entries(params.tgWebAppData) as [string, string][]).toString() : undefined
  } catch {
    return undefined
  }
}
