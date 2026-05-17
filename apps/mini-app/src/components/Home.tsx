import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { mainButton } from '@telegram-apps/sdk-react';
import { Library as LibraryIcon, BarChart3, Settings, Flame, ChevronDown, GraduationCap } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import {
  loadPracticeMode,
  type PracticeMode,
} from '../lib/practiceMode';
import { primeSpeech } from '../lib/tts';
import { primeAudio } from '../lib/audio';
import { getSettings } from '../lib/settings';
import { clearSession, loadSession, subscribeToSession } from '../lib/sessionPersist';
import { SettingsSheet } from './SettingsSheet';

import { motion } from 'framer-motion';

interface HomeProps {
  onStart: (mode: PracticeMode) => void;
  onOpenLibrary: () => void;
  onOpenStats: () => void;
  onOpenAnswers: () => void;
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

export function Home({ onStart, onOpenLibrary, onOpenStats, onOpenAnswers, userFirstName }: HomeProps) {
  const [mode, setMode] = useState<PracticeMode>(() => loadPracticeMode());
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const settings = getSettings();

  // Resume offer: detect a paused session
  const [pausedSession, setPausedSession] = useState(() => loadSession())
  useEffect(() => {
    const refresh = () => setPausedSession(loadSession())
    const unsubscribe = subscribeToSession(refresh)
    const id = setInterval(refresh, 30_000)
    return () => {
      unsubscribe()
      clearInterval(id)
    }
  }, [])

  const handleDiscardPaused = () => {
    clearSession()
    setPausedSession(null)
  }

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

  const { data: unreadData } = useQuery({
    queryKey: ['questions', 'count'],
    queryFn: async () => {
      const res = await fetchWithAuth('/questions/count');
      if (!res.ok) throw new Error('Failed to load')
      return (await res.json()) as { unread: number };
    },
    refetchInterval: 60_000,
    refetchOnMount: 'always',
  });
  const unreadCount = unreadData?.unread ?? 0;

  const due = stats?.dueCount ?? 0;
  const reviewed = stats?.reviewedToday ?? 0;
  const totalForToday = due + reviewed;
  
  const progressPercent = totalForToday > 0 ? (reviewed / totalForToday) * 100 : (reviewed > 0 ? 100 : 0);
  
  const radius = 72;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (progressPercent / 100) * circumference;

  // Wire the Telegram MainButton to "Start session"
  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    try {
      if (!isSettingsOpen) {
        mainButton.setParams({ text: pausedSession ? 'Продолжить сессию' : 'Начать сессию', isVisible: true, isEnabled: true })
        unsubscribe = mainButton.onClick(() => {
          primeSpeech()
          void primeAudio()
          onStart(pausedSession ? pausedSession.mode : mode)
        })
      } else {
        mainButton.setParams({ isVisible: false })
      }
    } catch {
      // SDK not mounted
    }
    return () => {
      try {
        unsubscribe?.()
        mainButton.setParams({ isVisible: false })
      } catch {
        // ditto
      }
    }
  }, [onStart, mode, isSettingsOpen, pausedSession])

  return (
    <div
      className="flex-1 flex flex-col p-6 justify-between bg-app-bg text-app-text relative overflow-hidden"
      style={{
        paddingTop: `calc(1.5rem + var(--tg-safe-area-inset-top, 0px))`,
        paddingBottom: `calc(2rem + var(--tg-safe-area-inset-bottom, 0px))`,
      }}
    >
      <div className="flex justify-between items-start z-10 relative text-app-text">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-xl font-bold mb-0.5 tracking-tight">{getGreeting(userFirstName)}</h1>
          <div className="flex items-center gap-2 flex-wrap">
             {stats && stats.streak > 0 && (
               <motion.div 
                 animate={due === 0 && reviewed > 0 ? { filter: ['drop-shadow(0 0 2px #f97316)', 'drop-shadow(0 0 8px #f97316)', 'drop-shadow(0 0 2px #f97316)'] } : {}}
                 transition={{ duration: 2, repeat: Infinity }}
                 className="flex items-center gap-1 text-orange-500 font-bold text-[10px] uppercase tracking-wider bg-orange-500/10 px-2 py-1 rounded-full border border-orange-500/20 shadow-sm"
               >
                 <Flame size={12} fill="currentColor" />
                 <span>{stats.streak} {pluralize(stats.streak, ['день', 'дня', 'дней'])}</span>
               </motion.div>
             )}
             <div className="bg-app-surface text-app-primary px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest border border-app-primary/30 shadow-sm flex items-center gap-1.5 active:scale-95 transition-transform cursor-default">
               <GraduationCap size={12} strokeWidth={2.5} className="opacity-80" />
               <span>{getRank(stats?.learnedCount ?? 0)}</span>
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
        <div className="relative w-56 h-56 flex items-center justify-center mb-8">
          {/* Background Ring */}
          <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 200 200">
            <circle
              cx="100"
              cy="100"
              r={radius}
              stroke="currentColor"
              strokeWidth="8"
              fill="transparent"
              className="text-app-primary/5"
            />
            {/* Progress Ring with soft glow */}
            <motion.circle
              cx="100"
              cy="100"
              r={radius}
              stroke="currentColor"
              strokeWidth="8"
              fill="transparent"
              strokeLinecap="round"
              className="text-app-primary"
              style={{ 
                strokeDasharray: circumference, 
                strokeDashoffset,
                filter: 'drop-shadow(0 0 3px rgba(79, 70, 229, 0.2))'
              }}
              initial={{ strokeDashoffset: circumference }}
              animate={{ strokeDashoffset }}
              transition={{ duration: 1.5, ease: 'circOut' }}
            />
          </svg>
          <div className="flex flex-col items-center text-center mt-1 px-4 relative">
            {due > 0 ? (
              <>
                <span className={`font-black text-app-text tracking-tighter leading-none transition-all ${
                  due > 999 ? 'text-4xl' : due > 99 ? 'text-5xl' : 'text-6xl'
                }`}>
                  {due}
                </span>
                <span className="text-[11px] font-black uppercase tracking-[0.25em] text-app-hint mt-3 opacity-60">К повтору</span>
              </>
            ) : reviewed > 0 ? (
              <>
                <motion.div
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="flex flex-col items-center"
                >
                  <span className={`font-black text-app-primary tracking-tighter leading-none ${
                    reviewed > 999 ? 'text-4xl' : reviewed > 99 ? 'text-5xl' : 'text-6xl'
                  }`}>
                    {reviewed}
                  </span>
                  <span className="text-[11px] font-black uppercase tracking-[0.25em] text-app-hint mt-3 opacity-60">Выполнено</span>
                </motion.div>
              </>
            ) : (
              <>
                <span className="text-5xl">📚</span>
                <span className="text-[11px] font-black uppercase tracking-[0.25em] text-app-hint mt-4 text-center opacity-60">Пусто</span>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-col items-center gap-6 w-full max-w-[280px]">
          <div className="bg-app-surface px-5 py-2 rounded-2xl border border-app-border shadow-sm">
            <p className="text-app-hint text-center text-[11px] font-bold uppercase tracking-wide">
              {totalForToday === 0
                ? <>Карточек к повтору нет</>
                : due === 0
                  ? <><span className="text-app-primary">{reviewed}</span> сегодня — отлично!</>
                  : <><span className="text-app-text">{reviewed}</span> из <span className="text-app-text">{totalForToday}</span> пройдено</>
              }
            </p>
          </div>

          {heatmapData && heatmapData.history.length > 0 && (
            <div className="w-full opacity-60">
               <h2 className="text-[10px] uppercase tracking-[0.15em] text-app-hint font-bold mb-3 text-center opacity-40">
                 История обучения
               </h2>
               <CompactHeatmap history={heatmapData.history} />
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3 relative z-10">
        {unreadCount > 0 && (
          <button
            onClick={onOpenAnswers}
            className="flex items-center gap-2 bg-app-primary/10 border border-app-primary/30 rounded-2xl px-3 py-2 text-sm active:scale-[0.98] transition-transform"
          >
            <span className="flex-1 text-app-text text-left text-[11px] font-semibold">
              🤖 Агент ответил на {unreadCount} {pluralize(unreadCount, ['вопрос', 'вопроса', 'вопросов'])}
            </span>
            <ChevronDown size={14} className="-rotate-90 text-app-primary" />
          </button>
        )}
        {pausedSession && (
          <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/30 rounded-2xl px-3 py-2 text-[11px]">
            <span className="flex-1 text-app-text font-medium">
              ⏸ Пауза: <span className="font-bold">{pausedSession.currentIndex} / {pausedSession.cards.length}</span>
            </span>
            <button
              onClick={handleDiscardPaused}
              className="text-app-hint font-bold uppercase tracking-tighter underline underline-offset-2 active:opacity-60"
            >
              Сбросить
            </button>
          </div>
        )}
        <div className="relative">
          <button
            className="w-full bg-app-primary text-app-primary-text py-4 rounded-2xl font-bold text-lg active:scale-95 transition-transform shadow-lg shadow-app-primary/20"
            onClick={() => {
              primeSpeech()
              void primeAudio()
              onStart(pausedSession ? pausedSession.mode : mode)
            }}
          >
            {pausedSession ? 'Продолжить сессию' : 'Начать сессию'}
          </button>
          
          <div className="mt-3 flex justify-center">
            <p className="text-[10px] text-app-hint font-bold uppercase tracking-[0.1em] opacity-60">
              Режим: <span className="text-app-text">{modeName(mode)}</span> 
              {settings.sessionLimit && <span className="ml-1">· {settings.sessionLimit} карт</span>}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mt-1">
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

      <SettingsSheet 
        isOpen={isSettingsOpen} 
        onClose={() => setIsSettingsOpen(false)}
        currentMode={mode}
        onModeChange={(m) => setMode(m)}
      />
    </div>
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
