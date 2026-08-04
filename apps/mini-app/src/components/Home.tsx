import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { mainButton } from '@telegram-apps/sdk-react';
import { Library as LibraryIcon, BarChart3, Settings, Flame, ChevronDown, GraduationCap, X, History } from 'lucide-react';
import { fetchWithAuth, API_BASE } from '../lib/api';
import { loadPracticeMode, type PracticeMode } from '../lib/practiceMode';
import { primeSpeech } from '../lib/tts';
import { primeAudio } from '../lib/audio';
import { useSettings } from '../lib/settings';
import { clearSession, loadSession, subscribeToSession } from '../lib/sessionPersist';
import { useT } from '../lib/i18n/useT';
import { plurKey } from '../lib/i18n/plural';
import { SettingsSheet } from './SettingsSheet';
import { AssignmentCard } from './AssignmentCard';
import { AssignmentHistory } from './AssignmentHistory';
import { BottomSheet } from './BottomSheet';
import { Markdown } from './Markdown';
import { useActiveAssignment } from '../hooks/useActiveAssignment';

import { motion } from 'framer-motion';

interface HomeProps {
  onStart: (mode: PracticeMode) => void;
  onStartAssignment: () => void;
  onOpenLibrary: () => void;
  onOpenStats: () => void;
  onOpenAnswers: () => void;
  userFirstName?: string;
}

type T = ReturnType<typeof useT>

function getGreeting(t: T, name?: string) {
  const hour = new Date().getHours();
  let timeKey: 'home.greeting_night' | 'home.greeting_morning' | 'home.greeting_day' | 'home.greeting_evening' = 'home.greeting_night'
  if (hour >= 5 && hour < 12) timeKey = 'home.greeting_morning';
  else if (hour >= 12 && hour < 18) timeKey = 'home.greeting_day';
  else if (hour >= 18 && hour < 23) timeKey = 'home.greeting_evening';
  const greeting = t(timeKey)
  return name
    ? t('home.greeting_with_name', { greeting, name })
    : t('home.greeting_no_name', { greeting })
}

function getRank(t: T, count: number): string {
  if (count >= 2000) return t('rank.rector')
  if (count >= 1000) return t('rank.doctor')
  if (count >= 500) return t('rank.master')
  if (count >= 200) return t('rank.bachelor')
  if (count >= 50) return t('rank.student')
  return t('rank.beginner')
}

export function Home({ onStart, onStartAssignment, onOpenLibrary, onOpenStats, onOpenAnswers, userFirstName }: HomeProps) {
  const [mode, setMode] = useState<PracticeMode>(() => loadPracticeMode());
  const [isSettingsOpen, setIsSettingsOpen] = useState(() => window.location.hash === '#settings');
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const { settings } = useSettings();
  const t = useT();

  useEffect(() => {
    const h = () => setIsSettingsOpen(window.location.hash === '#settings')
    window.addEventListener('hashchange', h)
    return () => window.removeEventListener('hashchange', h)
  }, [])

  const [pausedSession, setPausedSession] = useState(() => loadSession())
  useEffect(() => subscribeToSession(() => setPausedSession(loadSession())), [])

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

  const { data: assignmentData, isPending: isAssignmentPending } = useActiveAssignment();
  const assignment = assignmentData?.assignment ?? null;
  const [isRationaleOpen, setIsRationaleOpen] = useState(false);

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

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      try {
        const res = await fetch(`${API_BASE}/health`);
        if (!res.ok) return { ok: false };
        const data = (await res.json()) as { ok?: boolean };
        return { ok: data.ok === true };
      } catch {
        return { ok: false };
      }
    },
    refetchInterval: 30_000,
  });

  const due = stats?.dueCount ?? 0;
  const reviewed = stats?.reviewedToday ?? 0;
  const totalForToday = due + reviewed;

  // The ring belongs to whatever is currently the primary loop: the
  // assignment when one is live, today's queue otherwise.
  const ringDone = assignment ? assignment.completed : reviewed;
  const ringTotal = assignment ? assignment.total : totalForToday;

  // Until we know whether an assignment exists, the ring holds: empty and
  // still. Showing today's due count first and swapping it a beat later
  // makes every open of the app start with a number that turns out to be
  // the wrong one.
  const progressPercent = isAssignmentPending
    ? 0
    : ringTotal > 0
      ? (ringDone / ringTotal) * 100
      : ringDone > 0
        ? 100
        : 0;

  const radius = 72;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (progressPercent / 100) * circumference;

  // The single primary action, shared by the Telegram MainButton and its
  // in-app twin so the two can never disagree.
  const mainActionLabel = pausedSession
    ? t('home.resume_session')
    : assignment
      ? t('assignment.continue')
      : t('home.start_session');

  const startMainAction = useCallback(() => {
    if (pausedSession) onStart(pausedSession.mode);
    else if (assignment) onStartAssignment();
    else onStart(mode);
  }, [pausedSession, assignment, mode, onStart, onStartAssignment]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    try {
      if (!isSettingsOpen) {
        // Precedence: a paused free session resumes first — dropping someone
        // mid-session would lose their place. The assignment only outranks a
        // fresh start.
        mainButton.setParams({ text: mainActionLabel, isVisible: true, isEnabled: true })
        unsubscribe = mainButton.onClick(() => {
          primeSpeech()
          void primeAudio()
          startMainAction()
        })
      } else {
        mainButton.setParams({ isVisible: false })
      }
    } catch {
      // SDK not mounted (dev outside Telegram) — ignore.
    }
    return () => {
      try {
        unsubscribe?.()
        mainButton.setParams({ isVisible: false })
      } catch {
      // SDK not mounted (dev outside Telegram) — ignore.
    }
    }
  }, [isSettingsOpen, mainActionLabel, startMainAction])

  return (
    <div
      className="flex-1 flex flex-col p-6 justify-between bg-app-bg text-app-text relative overflow-hidden"
      style={{
        paddingTop: `calc(1.5rem + var(--tg-safe-area-inset-top, 0px))`,
        paddingBottom: `calc(1.5rem + var(--tg-safe-area-inset-bottom, 0px))`,
      }}
    >
      <div className="flex justify-between items-start z-10 relative text-app-text gap-3">
        <div className="flex-1 min-w-0 pt-1">
          <h1 className="text-[22px] font-black tracking-tight leading-[1.1] truncate pr-2">
            {getGreeting(t, userFirstName)}
          </h1>
          <div className="flex items-center gap-2 mt-2.5 flex-wrap">
             {stats && stats.streak > 0 && (
               <motion.div 
                 animate={due === 0 && reviewed > 0 ? { filter: ['drop-shadow(0 0 2px #f97316)', 'drop-shadow(0 0 8px #f97316)', 'drop-shadow(0 0 2px #f97316)'] } : {}}
                 transition={{ duration: 2, repeat: Infinity }}
                 className="flex items-center gap-1.5 text-orange-500 font-bold text-[10px] uppercase tracking-wider bg-orange-500/10 px-2.5 py-1.5 rounded-full border border-orange-500/20 shadow-sm"
               >
                 <Flame size={12} fill="currentColor" />
                 <span className="leading-none">{stats.streak} {t(plurKey(stats.streak, 'home.streak_one', 'home.streak_few', 'home.streak_many'))}</span>
               </motion.div>
             )}
             <div className="bg-app-surface text-app-primary px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-widest border border-app-primary/30 shadow-sm flex items-center gap-1.5 active:scale-95 transition-transform cursor-default h-[30px]">
               <GraduationCap size={13} strokeWidth={2.5} className="opacity-80" />
               <span className="leading-none">{getRank(t, stats?.learnedCount ?? 0)}</span>
             </div>
          </div>
        </div>
        
        <div className="flex flex-col items-end gap-2 shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsHistoryOpen(true)}
              className="p-3 text-app-hint active:opacity-60 transition-opacity bg-app-surface border border-app-border rounded-2xl shadow-sm"
              aria-label={t('assignment.history_title')}
            >
              <History size={22} />
            </button>
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="p-3 text-app-hint active:opacity-60 transition-opacity bg-app-surface border border-app-border rounded-2xl shadow-sm"
              aria-label={t('home.aria_settings')}
            >
              <Settings size={22} />
            </button>
          </div>
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[8px] font-black uppercase tracking-widest transition-colors ${
            health?.ok 
              ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500' 
              : 'bg-rose-500/10 border-rose-500/20 text-rose-500 animate-pulse'
          }`}>
            <span className={`w-1 h-1 rounded-full ${health?.ok ? 'bg-emerald-500 shadow-[0_0_4px_rgba(16,185,129,0.5)]' : 'bg-rose-500'} ${health?.ok ? 'animate-pulse' : ''}`} />
            {health?.ok ? 'Hermes' : 'Offline'}
          </div>
        </div>
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
          <div className="flex flex-col items-center text-center mt-1 px-4 relative min-h-[120px] justify-center">
            {isAssignmentPending ? null : assignment ? (
              <>
                <span className="font-black text-app-text tracking-tighter leading-none text-5xl">
                  {ringDone}
                  <span className="text-2xl opacity-40">/{ringTotal}</span>
                </span>
                <div className="h-4 flex items-center mt-3">
                  <span className="text-[10px] font-black uppercase tracking-[0.2em] text-app-hint opacity-60 leading-none">
                    {t('assignment.ring_label')}
                  </span>
                </div>
              </>
            ) : due > 0 ? (
              <>
                <span className={`font-black text-app-text tracking-tighter leading-none transition-all ${
                  due > 999 ? 'text-4xl' : due > 99 ? 'text-5xl' : 'text-6xl'
                }`}>
                  {due}
                </span>
                <div className="h-4 flex items-center mt-3">
                  <span className="text-[10px] font-black uppercase tracking-[0.2em] text-app-hint opacity-60 leading-none">
                    {t('home.ring_to_review')}
                  </span>
                </div>
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
                  <div className="h-4 flex items-center mt-3">
                    <span className="text-[10px] font-black uppercase tracking-[0.2em] text-app-hint opacity-60 leading-none">
                      {t('home.ring_done_label')}
                    </span>
                  </div>
                </motion.div>
              </>
            ) : (
              <>
                <span className="text-5xl opacity-20">📚</span>
                <div className="h-4 flex items-center mt-4">
                  <span className="text-[10px] font-black uppercase tracking-[0.2em] text-app-hint text-center opacity-60 leading-none">
                    {t('home.ring_empty')}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-col items-center gap-6 w-full max-w-[340px]">
          {isAssignmentPending ? null : assignment ? (
            <AssignmentCard assignment={assignment} onOpenRationale={() => setIsRationaleOpen(true)} />
          ) : stats && stats.learnedCount === 0 && totalForToday === 0 ? (
            <div className="bg-app-primary/10 border border-app-primary/20 rounded-2xl p-4 text-center">
              <h3 className="font-bold text-app-primary text-sm mb-1">{t('home.welcome_title')}</h3>
              <p className="text-xs text-app-text/80 leading-relaxed">{t('home.welcome_desc')}</p>
            </div>
          ) : (
            <div className="bg-app-surface px-5 py-2 rounded-2xl border border-app-border shadow-sm">
              <p className="text-app-hint text-center text-[11px] font-bold uppercase tracking-wide">
                {totalForToday === 0
                  ? t('home.no_due')
                  : due === 0
                    ? t('home.progress_done_excellent', { reviewed })
                    : t('home.progress_in_progress', { reviewed, total: totalForToday })
                }
              </p>
            </div>
          )}

          <div className="flex flex-col gap-3 w-full mt-2">
            {unreadCount > 0 && (
              <button
                onClick={onOpenAnswers}
                className="flex items-center gap-3 bg-app-primary/10 border border-app-primary/20 rounded-2xl px-4 py-3.5 text-sm active:scale-[0.98] transition-transform shadow-sm"
              >
                <span className="flex-1 text-app-text text-left text-[11px] font-bold tracking-tight">
                  🤖 {t('home.agent_answered', { count: unreadCount, plural: t(plurKey(unreadCount, 'home.agent_answered_plural_one', 'home.agent_answered_plural_few', 'home.agent_answered_plural_many')) })}
                </span>
                <ChevronDown size={14} className="-rotate-90 text-app-primary" />
              </button>
            )}
            {pausedSession && (
              <div className="flex items-center gap-3 bg-amber-500/10 border border-amber-500/20 rounded-2xl px-4 py-3.5 text-[11px] shadow-sm">
                <span className="flex-1 text-app-text font-bold tracking-tight">
                  {t('home.paused_pill', { current: pausedSession.currentIndex, total: pausedSession.cards.length })}
                </span>
                <button
                  onClick={handleDiscardPaused}
                  className="text-app-hint font-black uppercase tracking-tighter underline underline-offset-2 active:opacity-60 text-[10px]"
                >
                  {t('common.discard')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 relative z-10">
        <div className="relative">
          <button
            className="w-full bg-app-primary text-app-primary-text py-4 rounded-2xl font-bold text-lg active:scale-95 transition-transform shadow-lg shadow-app-primary/20"
            onClick={() => {
              primeSpeech()
              void primeAudio()
              startMainAction()
            }}
          >
            {mainActionLabel}
          </button>
          
          <div className="mt-3 flex flex-col items-center gap-1.5 opacity-60">
            <p className="text-[10px] text-app-hint font-bold uppercase tracking-[0.1em]">
              {t('settings.mode_label')}: <span className="text-app-text">{t(modeKey(mode))}</span>
              {settings.sessionLimit && <span className="ml-1">· {settings.sessionLimit}</span>}
            </p>
          </div>
        </div>

        {assignment && !pausedSession && (
          // The pressure valve: free practice one tap away, quiet, no badge
          // and no count — a ghost against the filled primary above it. Shown
          // only while the assignment IS that primary: with a session paused
          // the primary already resumes free practice, so a second button for
          // it would duplicate, and misdescribe, the same tap.
          <button
            onClick={() => onStart(mode)}
            className="flex items-center justify-center gap-2 bg-app-surface border border-app-border rounded-2xl px-4 py-3 text-[11px] font-bold text-app-hint active:scale-[0.98] transition-transform"
          >
            {t('assignment.free_practice')}
          </button>
        )}

        <div className="grid grid-cols-2 gap-3 mt-1">
          <button
            onClick={onOpenLibrary}
            className="flex items-center justify-center gap-2 py-3 rounded-2xl border border-app-border bg-app-surface text-app-text font-semibold active:scale-95 transition-transform shadow-sm"
          >
            <LibraryIcon size={18} className="text-app-hint" />
            {t('home.btn_library')}
          </button>
          <button
            onClick={onOpenStats}
            className="flex items-center justify-center gap-2 py-3 rounded-2xl border border-app-border bg-app-surface text-app-text font-semibold active:scale-95 transition-transform shadow-sm"
          >
            <BarChart3 size={18} className="text-app-hint" />
            {t('home.btn_stats')}
          </button>
        </div>
      </div>

      {assignment !== null && assignment.rationale !== null && (
        <BottomSheet isOpen={isRationaleOpen} onClose={() => setIsRationaleOpen(false)} maxHeight="75vh">
          <div className="flex justify-between items-start mb-4 text-app-text gap-3">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-widest text-app-hint font-bold mb-0.5">
                {t('assignment.rationale_title')}
              </div>
              <h2 className="text-lg font-bold leading-tight">{assignment.title}</h2>
            </div>
            <button
              onClick={() => setIsRationaleOpen(false)}
              className="p-2 -mr-2 shrink-0 text-app-hint active:scale-95 transition-transform"
              aria-label={t('common.close')}
            >
              <X size={20} />
            </button>
          </div>

          <Markdown className="text-sm text-app-text/90">{assignment.rationale}</Markdown>

          <div style={{ height: 'calc(0.5rem + var(--tg-safe-area-inset-bottom, 0px))' }} />
        </BottomSheet>
      )}

      <AssignmentHistory isOpen={isHistoryOpen} onClose={() => setIsHistoryOpen(false)} />

      <SettingsSheet
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        currentMode={mode}
        onModeChange={(m) => setMode(m)}
      />
    </div>
  );
}

function modeKey(mode: PracticeMode): 'mode.mixed' | 'mode.recognition' | 'mode.cloze' | 'mode.translation' | 'mode.listening' {
  switch (mode) {
    case 'mixed': return 'mode.mixed';
    case 'recognition': return 'mode.recognition';
    case 'cloze': return 'mode.cloze';
    case 'translation': return 'mode.translation';
    case 'listening': return 'mode.listening';
  }
}
