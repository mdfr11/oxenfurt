import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { mainButton } from '@telegram-apps/sdk-react';
import { Library as LibraryIcon, BarChart3, Settings, Flame, ChevronDown, GraduationCap } from 'lucide-react';
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

function getRank(count: number): string {
  if (count >= 2000) return 'Ректор Академии';
  if (count >= 1000) return 'Доктор наук';
  if (count >= 500) return 'Магистр';
  if (count >= 200) return 'Бакалавр';
  if (count >= 50) return 'Студент';
  return 'Абитуриент';
}

export function Home({ onStart, onOpenLibrary, onOpenStats, userFirstName }: HomeProps) {
  const [mode, setMode] = useState<PracticeMode>(() => loadPracticeMode());
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isModeSelectOpen, setIsModeSelectOpen] = useState(false);

  // Home stays mounted while the user is in a session — without a polling
  // interval the dueCount/reviewedToday pill goes stale, and the user comes
  // back to "Карточек к повтору нет" even after Hermes just ingested new
  // ones. 30 s is invisible during use, cheap on the backend (one short
  // count query), and avoids the trap of relying on focus events that
  // Telegram WebView doesn't reliably fire.
  const { data: stats } = useQuery({
    queryKey: ['stats', 'today'],
    queryFn: async () => {
      const res = await fetchWithAuth('/stats/today');
      if (!res.ok) throw new Error('Failed to fetch stats');
      return (await res.json()) as { reviewedToday: number; dueCount: number; streak: number; learnedCount: number };
    },
    refetchInterval: 30_000,
    refetchOnMount: 'always',
  });

  const { data: heatmapData } = useQuery({
    queryKey: ['stats', 'heatmap'],
    queryFn: async () => {
      const res = await fetchWithAuth('/stats/heatmap');
      if (!res.ok) throw new Error('Failed to fetch heatmap');
      return (await res.json()) as { history: { date: string; count: number }[] };
    },
    refetchOnMount: 'always',
  });

  const due = stats?.dueCount ?? 0;
  const reviewed = stats?.reviewedToday ?? 0;
  const totalForToday = due + reviewed;
  // No cards in flight today → arc empty, not full. A full arc with zero
  // activity reads as "completed!", which is misleading when nothing has
  // happened in the first place — the user complained about exactly this.
  const progressPercent = totalForToday > 0 ? (reviewed / totalForToday) * 100 : 0;
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
        <div className="flex flex-col gap-1.5">
          <h1 className="text-xl font-bold tracking-tight">{getGreeting(userFirstName)}</h1>
          <div className="flex items-center gap-2">
             {stats && stats.streak > 0 && (
               <motion.div 
                 animate={due === 0 && reviewed > 0 ? { filter: ['drop-shadow(0 0 2px #f97316)', 'drop-shadow(0 0 8px #f97316)', 'drop-shadow(0 0 2px #f97316)'] } : {}}
                 transition={{ duration: 2, repeat: Infinity }}
                 className="flex items-center gap-1 text-orange-500 font-bold text-xs bg-orange-500/10 px-2 py-0.5 rounded-full border border-orange-500/20 shadow-sm"
               >
                 <Flame size={14} fill="currentColor" />
                 <span>{stats.streak} {pluralize(stats.streak, ['день', 'дня', 'дней'])}</span>
               </motion.div>
             )}
             <div className="bg-app-primary/10 text-app-primary px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border border-app-primary/20 shadow-sm flex items-center gap-1.5">
               <GraduationCap size={12} strokeWidth={2.5} />
               {getRank(stats?.learnedCount ?? 0)}
             </div>
          </div>
        </div>
        <button 
          onClick={() => setIsSettingsOpen(true)}
          className="p-2 text-app-hint active:opacity-60 transition-opacity bg-app-surface/50 border border-app-border rounded-xl shadow-sm"
          aria-label="Настройки"
        >
          <Settings size={22} />
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center relative z-0">
        <div className="relative w-48 h-48 flex items-center justify-center mb-8">
          {/* Background Ring */}
          <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 192 192">
            <circle
              cx="96"
              cy="96"
              r={radius}
              stroke="currentColor"
              strokeWidth="12"
              fill="transparent"
              className="text-app-primary/5"
            />
            {/* Progress Ring */}
            <circle
              cx="96"
              cy="96"
              r={radius}
              stroke="currentColor"
              strokeWidth="12"
              fill="transparent"
              strokeLinecap="round"
              className="text-app-primary transition-all duration-1000 ease-out"
              style={{ strokeDasharray: circumference, strokeDashoffset }}
            />
          </svg>
          <div className="flex flex-col items-center text-center mt-1 px-4 relative">
            {due > 0 ? (
              <>
                <span className="text-5xl font-black text-app-text tracking-tighter leading-none">{due}</span>
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-app-hint mt-2">К повтору</span>
              </>
            ) : reviewed > 0 ? (
              <>
                <motion.div
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="flex flex-col items-center"
                >
                  <span className="text-4xl font-black text-app-primary tracking-tighter leading-none">{reviewed}</span>
                  <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-app-hint mt-2">Выполнено</span>
                </motion.div>
              </>
            ) : (
              <>
                <span className="text-4xl">📚</span>
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-app-hint mt-2">Пусто</span>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-col items-center gap-6 w-full max-w-[280px]">
          <div className="bg-app-surface px-5 py-2 rounded-2xl border border-app-border shadow-sm">
            <p className="text-app-hint text-center text-xs font-semibold">
              {totalForToday === 0
                ? <>Карточек к повтору сейчас нет</>
                : due === 0
                  ? <><span className="text-app-primary font-bold">{reviewed}</span> сегодня — отличный результат!</>
                  : <><span className="text-app-text font-bold">{reviewed}</span> из <span className="text-app-text font-bold">{totalForToday}</span> карточек пройдено</>
              }
            </p>
          </div>

          {heatmapData && heatmapData.history.length > 0 && (
            <div className="w-full">
               <h2 className="text-[10px] uppercase tracking-[0.15em] text-app-hint font-bold mb-3 text-center opacity-40">
                 История обучения
               </h2>
               <CompactHeatmap history={heatmapData.history} />
            </div>
          )}
        </div>
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

function CompactHeatmap({ history }: { history: { date: string; count: number }[] }) {
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const h of history) m.set(h.date, h.count)
    return m
  }, [history])

  // Show last 12 weeks (3 months)
  const WEEKS = 12
  const totalDays = WEEKS * 7
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  
  const cells = []
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(today)
    d.setDate(d.getDate() - (totalDays - 1 - i))
    const iso = d.toISOString().slice(0, 10)
    cells.push({
      date: iso,
      count: counts.get(iso) ?? 0
    })
  }

  return (
    <div className="flex flex-col items-center">
      <div className="grid grid-flow-col gap-1" style={{ gridTemplateRows: 'repeat(7, 6px)' }}>
        {cells.map(c => (
           <div 
             key={c.date} 
             className={`w-[6px] h-[6px] rounded-[1px] ${
               c.count === 0 ? 'bg-app-hint/10' : 
               c.count < 5 ? 'bg-app-primary/30' :
               c.count < 15 ? 'bg-app-primary/60' : 'bg-app-primary'
             }`}
           />
        ))}
      </div>
    </div>
  )
}
