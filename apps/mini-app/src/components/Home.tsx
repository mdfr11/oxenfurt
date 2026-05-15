import { useEffect, useState } from 'react';
import { mainButton } from '@telegram-apps/sdk-react';
import { BookOpen, Library as LibraryIcon, BarChart3 } from 'lucide-react';
import {
  loadPracticeMode,
  savePracticeMode,
  type PracticeMode,
} from '../lib/practiceMode';
import { primeSpeech } from '../lib/tts';
import { primeAudio } from '../lib/audio';

interface HomeProps {
  onStart: (mode: PracticeMode) => void;
  onOpenLibrary: () => void;
  onOpenStats: () => void;
  userFirstName?: string;
}

export function Home({ onStart, onOpenLibrary, onOpenStats, userFirstName }: HomeProps) {
  const [mode, setMode] = useState<PracticeMode>(() => loadPracticeMode());

  function selectMode(next: PracticeMode) {
    setMode(next);
    savePracticeMode(next);
  }

  // Wire the Telegram MainButton to "Start session" — fires with the
  // currently-selected mode, captured fresh each render.
  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    try {
      mainButton.setParams({ text: 'Начать сессию', isVisible: true, isEnabled: true })
      unsubscribe = mainButton.onClick(() => {
        primeSpeech()
        void primeAudio()
        onStart(mode)
      })
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
  }, [onStart, mode])

  return (
    <div
      className="flex-1 flex flex-col p-6 justify-between bg-app-bg text-app-text"
      style={{
        paddingTop: `calc(1.5rem + var(--tg-safe-area-inset-top, 0px))`,
        paddingBottom: `calc(2rem + var(--tg-safe-area-inset-bottom, 0px))`,
      }}
    >
      <div className="flex-1 flex flex-col items-center justify-center">
        <div className="w-24 h-24 bg-app-surface border border-app-border rounded-[2rem] flex items-center justify-center text-app-primary shadow-sm mb-8">
          <BookOpen size={48} strokeWidth={1.5} />
        </div>
        <h1 className="text-3xl font-bold mb-2">Oxenfurt</h1>
        <p className="text-app-hint text-center max-w-[280px]">
          {userFirstName ? `Привет, ${userFirstName}! ` : ''}
          Твои карточки готовы к повторению.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {/* Mode picker — two rows on narrow screens, one on wider ones */}
        <div className="grid grid-cols-3 gap-1 bg-app-surface border border-app-border rounded-2xl p-1">
          <ModeChip active={mode === 'mixed'} onClick={() => selectMode('mixed')}>
            Смешанно
          </ModeChip>
          <ModeChip active={mode === 'recognition'} onClick={() => selectMode('recognition')}>
            Узнавание
          </ModeChip>
          <ModeChip active={mode === 'cloze'} onClick={() => selectMode('cloze')}>
            Письмо
          </ModeChip>
          <ModeChip active={mode === 'translation'} onClick={() => selectMode('translation')}>
            Перевод
          </ModeChip>
          <ModeChip active={mode === 'listening'} onClick={() => selectMode('listening')}>
            Слух
          </ModeChip>
          <span className="invisible" aria-hidden="true" />
        </div>

        <p className="text-[11px] text-app-hint text-center -mt-1 mb-1">
          {modeHelp(mode)}
        </p>

        {/* In-webview fallback for dev / non-Telegram environments. */}
        <button
          className="w-full bg-app-primary text-app-primary-text py-4 rounded-2xl font-semibold text-lg active:scale-95 transition-transform shadow-lg shadow-app-primary/20"
          onClick={() => {
            // Unlock both audio paths from this real user gesture:
            //   * speechSynthesis — required for TTS in "Слух" / 🔊 button.
            //   * AudioContext     — required for UI feedback sounds
            //                         (pop / thud) on Android WebView.
            // Without this priming, mobile browsers silently drop the first
            // play because there hasn't been a recent gesture in their model.
            primeSpeech()
            void primeAudio()
            onStart(mode)
          }}
        >
          Начать сессию
        </button>

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={onOpenLibrary}
            className="flex items-center justify-center gap-2 py-3 rounded-2xl border border-app-border bg-app-surface text-app-text font-semibold active:scale-95 transition-transform"
          >
            <LibraryIcon size={18} />
            Карточки
          </button>
          <button
            onClick={onOpenStats}
            className="flex items-center justify-center gap-2 py-3 rounded-2xl border border-app-border bg-app-surface text-app-text font-semibold active:scale-95 transition-transform"
          >
            <BarChart3 size={18} />
            Статистика
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-2 rounded-xl text-xs font-semibold transition-colors ${
        active
          ? 'bg-app-primary text-app-primary-text shadow-sm'
          : 'text-app-hint active:bg-app-bg'
      }`}
    >
      {children}
    </button>
  );
}

function modeHelp(mode: PracticeMode): string {
  if (mode === 'recognition') return 'Видишь слово — вспоминаешь перевод'
  if (mode === 'cloze') return 'Видишь предложение с пропуском — пишешь слово'
  if (mode === 'translation') return 'Видишь перевод — пишешь английское слово'
  if (mode === 'listening') return 'Слышишь слово — пишешь что услышал'
  return 'Перемешиваю варианты (без аудио)'
}
