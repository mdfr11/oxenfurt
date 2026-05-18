import { useSyncExternalStore } from 'react';

// The language the user is *learning*. The app is polyglot — same code
// works for English, Spanish, German, etc. Drives TTS voice selection,
// translation API langpair, and microcopy that mentions the language by
// name. Whitelist matches what Google Translate TTS and MyMemory both
// support; extending to other languages is a one-line addition.
export type LearningLanguage = 'en' | 'es' | 'de' | 'fr' | 'it' | 'pt' | 'ja' | 'zh' | 'ko'

// The user's native language — what translations land in and what the UI
// is rendered in by default. Same source-of-truth for i18n locale.
export type NativeLanguage = 'ru' | 'en'

interface AppSettings {
  soundEnabled: boolean;
  hapticsEnabled: boolean;
  autoPronounce: boolean;
  // Region variant for the TTS voice of `learningLanguage`. Currently only
  // English has two variants exposed; others use a single canonical
  // region picked in lib/tts.ts.
  voiceLocale: 'en-US' | 'en-GB';
  // What language the user is learning. Default 'en' for personal use;
  // forkers from other countries flip this in Settings.
  learningLanguage: LearningLanguage;
  // What language the user speaks natively — drives translation target
  // and UI strings.
  nativeLanguage: NativeLanguage;
  // Produce-mode (native → learning). When on, recognition-variant vocab
  // cards flip: translation on the front, term on the back. Forces the
  // user to recall the foreign form. Shares FSRS state with recognition.
  produceDirection: boolean;
  // Soft cap on session size. `null` = no cap (take all due cards from
  // the backend's default page). Respected by PracticeSession's /due
  // fetch via the ?limit query parameter.
  sessionLimit: number | null;
  // Show the "🤖 Проверить смыслом" button under miss feedback in
  // typed-answer modes. Off-by-default keeps the UI clean for people
  // who'd rather not lean on an LLM (or haven't configured one on the
  // backend at all — the button would just 503 anyway).
  aiGradingEnabled: boolean;
  // When you rate "Снова", spliсe the failed card back into the working
  // queue ~4 positions ahead so you re-see it before the session ends.
  // Default OFF — surprised users (the queue can grow from 10 to 11+)
  // outweighed the learning-step benefit. Power users who want Anki's
  // learning-step behaviour can flip it on.
  inSessionReplay: boolean;
  // Restrict the practice session to one card type. 'all' = no filter
  // (current behaviour). 'theory' is the obvious use case — grammar
  // notes get lost in a mixed-with-vocab session — but the option is
  // there for any single-type focus. Typed-answer modes (cloze /
  // translation / listening) auto-degrade to recognition for theory
  // cards since theory has nothing to type or pronounce.
  cardTypeFilter: 'all' | 'vocab' | 'phrase' | 'theory';
}

const DEFAULT_SETTINGS: AppSettings = {
  soundEnabled: true,
  hapticsEnabled: true,
  autoPronounce: false,
  voiceLocale: 'en-US',
  learningLanguage: 'en',
  nativeLanguage: 'ru',
  produceDirection: false,
  sessionLimit: null,
  aiGradingEnabled: false,
  inSessionReplay: false,
  cardTypeFilter: 'all',
};

const SETTINGS_KEY = 'oxenfurt_settings';

// Pub-sub store. Same shape as lib/i18n: one module-level value, one
// subscribers Set, and `saveSettings` notifies. Without this, the local
// `useState` in `useSettings()` is invisible to other components —
// SettingsSheet would update its own copy and Home/PracticeSession would
// silently lag until their next mount. With it, any save anywhere
// re-renders every subscriber.
//
// `cachedSettings` is the canonical in-memory snapshot. It MUST be the
// same reference between renders when nothing changed, otherwise
// useSyncExternalStore re-renders on every check.
let cachedSettings: AppSettings = readFromStorage();
const subscribers = new Set<() => void>();

function readFromStorage(): AppSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  const stored = localStorage.getItem(SETTINGS_KEY);
  if (stored === null) return DEFAULT_SETTINGS;
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function getSettings(): AppSettings {
  return cachedSettings;
}

export function saveSettings(settings: AppSettings): void {
  cachedSettings = settings;
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Restricted webview / quota — keep the in-memory copy.
    }
  }
  for (const cb of subscribers) cb();
}

export function subscribeSettings(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/**
 * Reactive hook: re-renders when ANY component calls `saveSettings` so
 * the displayed values stay in sync across screens. Returns the same
 * `{ settings, updateSettings }` shape as before so callers don't change.
 */
export function useSettings() {
  const settings = useSyncExternalStore(subscribeSettings, getSettings, getSettings);

  const updateSettings = (partial: Partial<AppSettings>) => {
    saveSettings({ ...cachedSettings, ...partial });
  };

  return { settings, updateSettings };
}
