import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { mainButton } from '@telegram-apps/sdk-react';
import { Library as LibraryIcon, BarChart3, Settings, Flame, ChevronDown } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import {
  loadPracticeMode,
  savePracticeMode,
  type PracticeMode,
} from '../lib/practiceMode';
import { primeSpeech } from '../lib/tts';
import { primeAudio } from '../lib/audio';
import { SettingsSheet } from './SettingsSheet';

import { AnimatePresence, motion } from 'framer-motion';

interface HomeProps {
  onStart: (mode: PracticeMode) => void;
  onOpenLibrary: () => void;
  onOpenStats: () => void;
  userFirstName?: string;
}

function getGreeting(name?: string) {
  const hour = new Date().getHours();
  let timeGreeting = 'Доброй ночи';
  if (hour >= 5 && hour < 12) timeGreeting = 'Доброе утро';
  else if (hour >= 12 && hour < 18) timeGreeting = 'Добрый день';
  else if (hour >= 18 && hour < 23) timeGreeting = 'Добрый вечер';
  
  return name ? `${timeGreeting}, ${name}!` : `${timeGreeting}!`;
}

export function Home({ onStart, onOpenLibrary, onOpenStats, userFirstName }: HomeProps) {
  const [mode, setMode] = useState<PracticeMode>(() => loadPracticeMode());
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isModeSelectOpen, setIsModeSelectOpen] = useState(false);

  const { data: stats } = useQuery({
    queryKey: ['stats', 'today'],
    queryFn: async () => {
      const res = await fetchWithAuth('/stats/today');
      if (!res.ok) throw new Error('Failed to fetch stats');
      return (await res.json()) as { reviewedToday: number; dueCount: number; streak: number };
    },
  });

  const due = stats?.dueCount ?? 0;
  const reviewed = stats?.reviewedToday ?? 0;
  const totalForToday = due + reviewed;
  const progressPercent = totalForToday > 0 ? (reviewed / totalForToday) * 100 : 100;
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (progressPercent / 100) * circumference;

  function selectMode(next: PracticeMode) {
    setMode(next);
    savePracticeMode(next);
    setIsModeSelectOpen(false);
  }

  // Wire the Telegram MainButton to "Start session"
  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    try {
      if (!isSettingsOpen && !isModeSelectOpen) {
        mainButton.setParams({ text: 'Начать сессию', isVisible: true, isEnabled: true })
        unsubscribe = mainButton.onClick(() => {
          primeSpeech()
          void primeAudio()
          onStart(mode)
        })
      } else {
        mainButton.setParams({ isVisible: false })
      }
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
  }, [onStart, mode, isSettingsOpen, isModeSelectOpen])

  return (
    <div
      className="flex-1 flex flex-col p-6 justify-between bg-app-bg text-app-text relative overflow-hidden"
      style={{
        paddingTop: `calc(1.5rem + var(--tg-safe-area-inset-top, 0px))`,
        paddingBottom: `calc(2rem + var(--tg-safe-area-inset-bottom, 0px))`,
      }}
    >
      <div className="flex justify-between items-start z-10 relative">
        <div>
          <h1 className="text-xl font-bold mb-1 tracking-tight">{getGreeting(userFirstName)}</h1>
          {stats && stats.streak > 0 ? (
            <div className="flex items-center gap-1.5 text-orange-500 font-semibold text-sm">
              <Flame size={16} fill="currentColor" className="drop-shadow-sm" />
              <span>{stats.streak} {pluralize(stats.streak, ['день', 'дня', 'дней'])} подряд</span>
            </div>
          ) : (
             <div className="text-app-hint text-sm">Карточки готовы к повторению</div>
          )}
        </div>
        <button 
          onClick={() => setIsSettingsOpen(true)}
          className="p-2 -mr-2 text-app-hint active:opacity-60 transition-opacity bg-app-surface/50 rounded-full"
          aria-label="Настройки"
        >
          <Settings size={22} />
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center -mt-4 relative z-0">
        <div className="relative w-48 h-48 flex items-center justify-center mb-6">
          {/* Background Ring */}
          <svg className="absolute inset-0 w-full h-full -rotate-90 drop-shadow-sm">
            <circle
              cx="96"
              cy="96"
              r={radius}
              stroke="currentColor"
              strokeWidth="10"
              fill="transparent"
              className="text-app-surface border border-app-border"
            />
            {/* Progress Ring */}
            <circle
              cx="96"
              cy="96"
              r={radius}
              stroke="currentColor"
              strokeWidth="10"
              fill="transparent"
              strokeLinecap="round"
              className="text-app-primary transition-all duration-1000 ease-out"
              style={{ strokeDasharray: circumference, strokeDashoffset }}
            />
          </svg>
          <div className="flex flex-col items-center text-center mt-1">
            {due > 0 ? (
              <>
                <span className="text-5xl font-black text-app-text tracking-tighter">{due}</span>
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-app-hint mt-1">Осталось</span>
              </>
            ) : (
              <span className="text-3xl font-bold text-app-primary text-center leading-tight">Всё<br/>готово</span>
            )}
          </div>
        </div>
        
        {reviewed > 0 && (
          <div className="bg-app-surface px-4 py-1.5 rounded-full border border-app-border shadow-sm">
            <p className="text-app-hint text-center text-xs font-semibold">
              Повторено сегодня: <span className="text-app-text">{reviewed}</span>
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4 relative z-10">
        <div className="relative">
          <button
            className="w-full bg-app-primary text-app-primary-text py-4 rounded-2xl font-bold text-lg active:scale-95 transition-transform shadow-lg shadow-app-primary/20"
            onClick={() => {
              primeSpeech()
              void primeAudio()
              onStart(mode)
            }}
          >
            Начать сессию
          </button>
          
          <div className="mt-4 flex justify-center">
            <button 
              onClick={() => setIsModeSelectOpen(!isModeSelectOpen)}
              className="flex items-center gap-1.5 text-xs font-semibold text-app-hint hover:text-app-text transition-colors py-1.5 px-4 rounded-full bg-app-surface border border-app-border shadow-sm active:scale-95"
            >
              Режим: {modeName(mode)} <ChevronDown size={14} className={`transition-transform ${isModeSelectOpen ? 'rotate-180' : ''}`} />
            </button>
          </div>

          {/* Minimalist Dropdown for Mode Selection */}
          <AnimatePresence>
            {isModeSelectOpen && (
              <motion.div
                initial={{ opacity: 0, y: 10, scale: 0.95, translateX: '-50%' }}
                animate={{ opacity: 1, y: 0, scale: 1, translateX: '-50%' }}
                exit={{ opacity: 0, y: 10, scale: 0.95, translateX: '-50%' }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                className="absolute bottom-[4.5rem] left-1/2 w-56 bg-app-surface border border-app-border rounded-2xl shadow-xl overflow-hidden z-20 flex flex-col p-1 origin-bottom"
              >
                <ModeOption active={mode === 'mixed'} onClick={() => selectMode('mixed')}>Смешанно</ModeOption>
                <ModeOption active={mode === 'recognition'} onClick={() => selectMode('recognition')}>Узнавание</ModeOption>
                <ModeOption active={mode === 'cloze'} onClick={() => selectMode('cloze')}>Письмо</ModeOption>
                <ModeOption active={mode === 'translation'} onClick={() => selectMode('translation')}>Перевод</ModeOption>
                <ModeOption active={mode === 'listening'} onClick={() => selectMode('listening')}>Слух</ModeOption>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="grid grid-cols-2 gap-3 mt-2">
          <button
            onClick={onOpenLibrary}
            className="flex items-center justify-center gap-2 py-3 rounded-2xl border border-app-border bg-app-surface text-app-text font-semibold active:scale-95 transition-transform shadow-sm"
          >
            <LibraryIcon size={18} className="text-app-hint" />
            Карточки
          </button>
          <button
            onClick={onOpenStats}
            className="flex items-center justify-center gap-2 py-3 rounded-2xl border border-app-border bg-app-surface text-app-text font-semibold active:scale-95 transition-transform shadow-sm"
          >
            <BarChart3 size={18} className="text-app-hint" />
            Статистика
          </button>
        </div>
      </div>
      
      {/* Dim overlay when dropdown is open */}
      <AnimatePresence>
        {isModeSelectOpen && (
           <motion.div 
             initial={{ opacity: 0 }}
             animate={{ opacity: 1 }}
             exit={{ opacity: 0 }}
             transition={{ duration: 0.15 }}
             className="fixed inset-0 bg-black/10 z-0" 
             onClick={() => setIsModeSelectOpen(false)}
           />
        )}
      </AnimatePresence>

      <SettingsSheet isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
    </div>
  );
}

function ModeOption({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`py-3 px-4 text-sm font-semibold text-left transition-colors rounded-xl ${
        active
          ? 'bg-app-primary/10 text-app-primary'
          : 'text-app-text active:bg-app-bg'
      }`}
    >
      {children}
    </button>
  );
}

function modeName(mode: PracticeMode): string {
  switch (mode) {
    case 'mixed': return 'Смешанно';
    case 'recognition': return 'Узнавание';
    case 'cloze': return 'Письмо';
    case 'translation': return 'Перевод';
    case 'listening': return 'Слух';
  }
}

function pluralize(n: number, forms: [string, string, string]): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 14) return forms[2]
  const mod10 = n % 10
  if (mod10 === 1) return forms[0]
  if (mod10 >= 2 && mod10 <= 4) return forms[1]
  return forms[2]
}