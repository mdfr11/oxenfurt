import { useEffect, useState } from 'react';
import { useRawInitData, useLaunchParams, retrieveLaunchParams } from '@telegram-apps/sdk-react';
import { Spinner } from '@telegram-apps/telegram-ui';
import { AnimatePresence, motion } from 'framer-motion';
import { API_BASE, loginWithTelegram, setToken } from './lib/api';
import { PracticeSession } from './components/PracticeSession';
import { Home } from './components/Home';
import { Summary } from './components/Summary';
import { Library } from './components/Library';
import { Stats } from './components/Stats';
import { loadPracticeMode, type PracticeMode } from './lib/practiceMode';

type Screen = 'home' | 'practice' | 'summary' | 'loading' | 'library' | 'stats';

interface SessionStats {
  total: number;
  correct: number;
}

const pageVariants = {
  initial: { opacity: 0, scale: 0.98 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 1.02 },
};

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
    <div className="app-container overflow-hidden">
      <AnimatePresence mode="wait">
        {screen === 'loading' && (
          <motion.div key="loading" variants={pageVariants} initial="initial" animate="animate" exit="exit" className="flex-1 flex items-center justify-center">
            <Spinner size="l" />
          </motion.div>
        )}
        {screen === 'practice' && (
          <motion.div key="practice" variants={pageVariants} initial="initial" animate="animate" exit="exit" className="flex-1 flex flex-col h-full absolute inset-0 bg-app-bg">
            <PracticeSession
              mode={practiceMode}
              onComplete={(total, correct) => {
                setStats({ total, correct });
                setScreen('summary');
              }}
              onExit={() => setScreen('home')}
            />
          </motion.div>
        )}
        {screen === 'summary' && (
          <motion.div key="summary" variants={pageVariants} initial="initial" animate="animate" exit="exit" className="flex-1 flex flex-col h-full absolute inset-0 bg-app-bg">
            <Summary
              stats={stats}
              onFinish={() => setScreen('home')}
              onRepeatHard={() => setScreen('practice')}
            />
          </motion.div>
        )}
        {screen === 'library' && (
          <motion.div key="library" variants={pageVariants} initial="initial" animate="animate" exit="exit" className="flex-1 flex flex-col h-full absolute inset-0 bg-app-bg">
            <Library onExit={() => setScreen('home')} />
          </motion.div>
        )}
        {screen === 'stats' && (
          <motion.div key="stats" variants={pageVariants} initial="initial" animate="animate" exit="exit" className="flex-1 flex flex-col h-full absolute inset-0 bg-app-bg">
            <Stats onExit={() => setScreen('home')} />
          </motion.div>
        )}
        {screen === 'home' && (
          <motion.div key="home" variants={pageVariants} initial="initial" animate="animate" exit="exit" className="flex-1 flex flex-col h-full absolute inset-0 bg-app-bg">
            <Home
              onStart={(mode) => {
                setPracticeMode(mode);
                setScreen('practice');
              }}
              onOpenLibrary={() => setScreen('library')}
              onOpenStats={() => setScreen('stats')}
              userFirstName={userFirstName}
            />
          </motion.div>
        )}
      </AnimatePresence>
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
