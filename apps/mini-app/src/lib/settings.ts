import { useState } from 'react';

interface AppSettings {
  soundEnabled: boolean;
  hapticsEnabled: boolean;
  autoPronounce: boolean;
  // Produce-mode (RU → EN). When on, recognition-variant vocab cards flip:
  // translation on the front, term on the back. Forces the user to recall
  // the English form. Shares FSRS state with recognition direction.
  produceDirection: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  soundEnabled: true,
  hapticsEnabled: true,
  autoPronounce: false,
  produceDirection: false,
};

const SETTINGS_KEY = 'oxenfurt_settings';

export function getSettings(): AppSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  const stored = localStorage.getItem(SETTINGS_KEY);
  if (stored) {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
    } catch {
      return DEFAULT_SETTINGS;
    }
  }
  return DEFAULT_SETTINGS;
}

export function saveSettings(settings: AppSettings) {
  if (typeof window !== 'undefined') {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }
}

export function useSettings() {
  const [settings, setSettingsState] = useState<AppSettings>(getSettings);

  const updateSettings = (newSettings: Partial<AppSettings>) => {
    const updated = { ...settings, ...newSettings };
    setSettingsState(updated);
    saveSettings(updated);
  };

  return { settings, updateSettings };
}
