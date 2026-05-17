import { useEffect, useState } from 'react';
import { useRawInitData, useLaunchParams, retrieveRawInitData } from '@telegram-apps/sdk-react';
import { Spinner } from '@telegram-apps/telegram-ui';
import { AnimatePresence, motion } from 'framer-motion';
import { API_BASE, loginWithTelegram, setToken } from './lib/api';
import { detectLocale, setLocale } from './lib/i18n';
import { getSettings, saveSettings } from './lib/settings';
import { PracticeSession } from './components/PracticeSession';
import { Home } from './components/Home';
import { Summary } from './components/Summary';
import { Library } from './components/Library';
import { Stats } from './components/Stats';
import { AnswersScreen } from './components/AnswersScreen';
import { loadPracticeMode, type PracticeMode } from './lib/practiceMode';

type Screen = 'home' | 'practice' | 'summary' | 'loading' | 'library' | 'stats' | 'answers';

interface SessionStats {
  total: number;
  correct: number;
}

const pageVariants = {
  initial: { opacity: 0, scale: 0.98 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 1.02, pointerEvents: 'none' as const },
};

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [stats, setStats] = useState<SessionStats>({ total: 0, correct: 0 });
  const [practiceMode, setPracticeMode] = useState<PracticeMode>(() => loadPracticeMode());

  // Hash-based navigation hack for automation/deep-linking
  useEffect(() => {
    const handleHash = () => {
      const h = window.location.hash
      if (h.includes('library')) setScreen('library')
      else if (h.includes('stats')) setScreen('stats')
      else if (h.includes('answers')) setScreen('answers')
      else if (h.includes('practice')) setScreen('practice')
      else if (h.includes('settings')) setScreen('home') // settings handled by prop
      else if (h.includes('home') || h === '') setScreen('home')
    }
    handleHash()
    window.addEventListener('hashchange', handleHash)
    return () => window.removeEventListener('hashchange', handleHash)
  }, [])
  const initDataRaw = useRawInitData();
  const launchParams = useLaunchParams();

  const userFirstName: string | undefined =
    launchParams.tgWebAppData?.user?.first_name

  // Pick UI language once on mount. Order of preference:
  //   1. Explicit user choice in settings (nativeLanguage)
  //   2. Telegram-reported locale
  //   3. English fallback
  // Persist whatever we landed on so the next boot is deterministic.
  useEffect(() => {
    const stored = getSettings()
    const tgCode = launchParams.tgWebAppData?.user?.language_code
    const chosen = detectLocale(stored.nativeLanguage ?? tgCode)
    setLocale(chosen)
    if (stored.nativeLanguage !== chosen) {
      saveSettings({ ...stored, nativeLanguage: chosen })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let cancelled = false
    // Only advance off the loading screen if the hashchange listener
    // hasn't already deep-linked elsewhere. Crucially: Telegram WebApp
    // populates location.hash with `#tgWebAppData=…&tgWebAppVersion=…`
    // — the previous `if (!h || h === '#home')` check returned false for
    // that, so every fresh open from Telegram silently hung on the
    // spinner. Use functional setState so we observe the live screen
    // state set by the deep-link effect above, not a stale closure.
    const exitLoading = () => {
      if (cancelled) return
      setScreen((prev) => (prev === 'loading' ? 'home' : prev))
    }
    async function auth() {
      if (import.meta.env.DEV) {
        try {
          const res = await fetch(`${API_BASE}/auth/dev-token`);
          if (res.ok) {
            const data = (await res.json()) as { token: string };
            setToken(data.token);
          }
        } catch (err) {
          console.error('Dev auth failed', err);
        }
        exitLoading();
        return;
      }

      const data = initDataRaw ?? safeRetrieveInitData()
      if (data === undefined) {
        exitLoading();
        return
      }

      try {
        await loginWithTelegram(data);
        exitLoading();
      } catch (err) {
        console.error('Auth failed', err);
        exitLoading();
      }
    }
    auth();
    return () => {
      cancelled = true
    }
  }, [initDataRaw]);

  return (
    <div data-testid="app-ready" className="app-container overflow-hidden relative">
      <AnimatePresence mode="wait">
        {screen === 'loading' ? (
          <motion.div key="loading" variants={pageVariants} initial="initial" animate="animate" exit="exit" className="flex-1 flex flex-col h-full absolute inset-0 bg-app-bg z-50">
            <div className="flex-1 flex items-center justify-center">
              <Spinner size="l" />
            </div>
          </motion.div>
        ) : screen === 'practice' ? (
          <motion.div key="practice" variants={pageVariants} initial="initial" animate="animate" exit="exit" className="flex-1 flex flex-col h-full absolute inset-0 bg-app-bg z-40">
            <PracticeSession
              mode={practiceMode}
              onComplete={(total, correct) => {
                setStats({ total, correct });
                setScreen('summary');
              }}
              onExit={() => setScreen('home')}
            />
          </motion.div>
        ) : screen === 'summary' ? (
          <motion.div key="summary" variants={pageVariants} initial="initial" animate="animate" exit="exit" className="flex-1 flex flex-col h-full absolute inset-0 bg-app-bg z-40">
            <Summary
              stats={stats}
              onFinish={() => setScreen('home')}
              onRepeatHard={() => setScreen('practice')}
            />
          </motion.div>
        ) : screen === 'library' ? (
          <motion.div key="library" variants={pageVariants} initial="initial" animate="animate" exit="exit" className="flex-1 flex flex-col h-full absolute inset-0 bg-app-bg z-40">
            <Library onExit={() => setScreen('home')} />
          </motion.div>
        ) : screen === 'stats' ? (
          <motion.div key="stats" variants={pageVariants} initial="initial" animate="animate" exit="exit" className="flex-1 flex flex-col h-full absolute inset-0 bg-app-bg z-40">
            <Stats onExit={() => setScreen('home')} />
          </motion.div>
        ) : screen === 'answers' ? (
          <motion.div key="answers" variants={pageVariants} initial="initial" animate="animate" exit="exit" className="flex-1 flex flex-col h-full absolute inset-0 bg-app-bg z-40">
            <AnswersScreen onExit={() => setScreen('home')} />
          </motion.div>
        ) : (
          <motion.div key="home" variants={pageVariants} initial="initial" animate="animate" exit="exit" className="flex-1 flex flex-col h-full absolute inset-0 bg-app-bg z-10">
            <Home
              onStart={(mode) => {
                setPracticeMode(mode);
                setScreen('practice');
              }}
              onOpenLibrary={() => setScreen('library')}
              onOpenStats={() => setScreen('stats')}
              onOpenAnswers={() => setScreen('answers')}
              userFirstName={userFirstName}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function safeRetrieveInitData(): string | undefined {
  // The previous implementation re-serialised an already-parsed
  // `tgWebAppData` via `URLSearchParams(Object.entries(...))`. That
  // dance coerced nested objects (like `user`) to the string
  // `[object Object]`, producing an init-data payload that always
  // failed HMAC validation. The SDK's `retrieveRawInitData()` returns
  // the original signed string — the only form the backend can verify.
  try {
    return retrieveRawInitData()
  } catch {
    return undefined
  }
}
