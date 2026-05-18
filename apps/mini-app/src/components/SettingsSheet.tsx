import { Settings, Volume2, Vibrate, X, Play, Headphones, ArrowLeftRight, Languages, Sparkles, Layout, Globe, Mic2, MessageSquare } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useSettings } from '../lib/settings';
import { hapticFeedback } from '@telegram-apps/sdk-react';
import { playPopSound } from '../lib/audio';
import { type PracticeMode, savePracticeMode } from '../lib/practiceMode';
import { useT } from '../lib/i18n/useT';
import { setLocale } from '../lib/i18n';

export function SettingsSheet({ 
  isOpen, 
  onClose,
  currentMode,
  onModeChange
}: { 
  isOpen: boolean; 
  onClose: () => void;
  currentMode: PracticeMode;
  onModeChange: (mode: PracticeMode) => void;
}) {
  const { settings, updateSettings } = useSettings();
  const t = useT();

  const testHaptics = (e: React.MouseEvent) => {
    e.preventDefault();
    try {
      hapticFeedback.notificationOccurred('success');
    } catch {
      // ignore
    }
  };

  const testSound = (e: React.MouseEvent) => {
    e.preventDefault();
    playPopSound();
  };

  const selectSessionLimit = (limit: number | null) => {
    updateSettings({ sessionLimit: limit });
  };

  const selectMode = (mode: PracticeMode) => {
    onModeChange(mode);
    savePracticeMode(mode);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/50 z-[100]"
          />
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', bounce: 0, duration: 0.35 }}
            className="fixed bottom-0 inset-x-0 bg-app-bg rounded-t-[2rem] z-[101] shadow-[0_-10px_40px_rgba(0,0,0,0.2)] flex flex-col max-w-[500px] mx-auto max-h-[92vh] overflow-hidden"
          >
            {/* Header */}
            <div 
              className="flex justify-between items-center px-6 pt-6 pb-4 border-b border-app-border text-app-text bg-app-bg"
              style={{ paddingTop: `calc(1.25rem + var(--tg-safe-area-inset-top, 0px))` }}
            >
              <h2 className="text-xl font-bold flex items-center gap-2">
                <Settings size={22} className="text-app-primary" /> {t('settings.title')}
              </h2>
              <button
                onClick={onClose}
                className="w-10 h-10 flex items-center justify-center rounded-full bg-app-surface border border-app-border text-app-hint shadow-sm active:scale-95 transition-transform"
                aria-label={t('common.close')}
              >
                <X size={20} strokeWidth={2.5} />
              </button>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto p-6 space-y-8 no-scrollbar">
              
              {/* PRACTICE SECTION */}
              <section className="space-y-4">
                <SectionHeader icon={Layout} label={t('settings.section_practice')} />
                
                <div className="bg-app-surface border border-app-border rounded-2xl overflow-hidden divide-y divide-app-border">
                  {/* Mode Picker */}
                  <div className="p-4 space-y-3">
                    <div className="text-xs font-bold text-app-text">{t('settings.mode_label')}</div>
                    <div className="grid grid-cols-2 gap-2">
                      <ModeOption active={currentMode === 'mixed'} onClick={() => selectMode('mixed')}>{t('mode.mixed')}</ModeOption>
                      <ModeOption active={currentMode === 'recognition'} onClick={() => selectMode('recognition')}>{t('mode.recognition')}</ModeOption>
                      <ModeOption active={currentMode === 'cloze'} onClick={() => selectMode('cloze')}>{t('mode.cloze')}</ModeOption>
                      <ModeOption active={currentMode === 'translation'} onClick={() => selectMode('translation')}>{t('mode.translation')}</ModeOption>
                      <ModeOption active={currentMode === 'listening'} onClick={() => selectMode('listening')}>{t('mode.listening')}</ModeOption>
                    </div>
                  </div>

                  {/* Session Size */}
                  <div className="p-4 space-y-3">
                    <div className="flex justify-between items-center">
                      <div className="text-xs font-bold text-app-text">{t('settings.size_label')}</div>
                      <div className="text-[10px] text-app-hint font-medium uppercase tracking-wider">{t('settings.size_hint')}</div>
                    </div>
                    <div className="flex gap-2">
                      {([null, 10, 20, 30] as const).map((n) => (
                        <button
                          key={n ?? 'all'}
                          onClick={() => selectSessionLimit(n)}
                          className={`flex-1 py-2.5 rounded-xl border text-xs font-black transition-all active:scale-95 ${
                            settings.sessionLimit === n
                              ? 'bg-app-primary text-app-primary-text border-app-primary shadow-md'
                              : 'bg-app-bg text-app-hint border-app-border'
                          }`}
                        >
                          {n === null ? t('settings.size_all') : n}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Card Type Filter */}
                  <div className="p-4 space-y-3">
                    <div className="flex justify-between items-center">
                      <div className="text-xs font-bold text-app-text">{t('settings.card_type_label')}</div>
                      <div className="text-[10px] text-app-hint font-medium uppercase tracking-wider">{t('settings.card_type_hint')}</div>
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      {(['all', 'vocab', 'phrase', 'theory'] as const).map((kind) => (
                        <button
                          key={kind}
                          onClick={() => updateSettings({ cardTypeFilter: kind })}
                          className={`py-2.5 rounded-xl border text-[10px] font-black uppercase tracking-tight transition-all active:scale-95 ${
                            settings.cardTypeFilter === kind
                              ? 'bg-app-primary text-app-primary-text border-app-primary shadow-md'
                              : 'bg-app-bg text-app-hint border-app-border'
                          }`}
                        >
                          {t(`settings.card_type_${kind}` as const)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              {/* LANGUAGES SECTION */}
              <section className="space-y-4">
                <SectionHeader icon={Globe} label={t('settings.section_languages')} />
                
                <div className="bg-app-surface border border-app-border rounded-2xl overflow-hidden divide-y divide-app-border">
                  {/* Native Language */}
                  <div className="p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-lg bg-indigo-500/10 text-indigo-500 flex items-center justify-center">
                        <Globe size={14} />
                      </div>
                      <div className="text-xs font-bold text-app-text">{t('settings.native_lang_label')}</div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {(['ru', 'en'] as const).map((code) => (
                        <button
                          key={code}
                          onClick={() => { updateSettings({ nativeLanguage: code }); setLocale(code); }}
                          className={`py-2.5 rounded-xl text-xs font-bold border transition-all ${
                            settings.nativeLanguage === code
                              ? 'bg-app-primary text-app-primary-text border-app-primary shadow-sm'
                              : 'bg-app-bg text-app-hint border-app-border'
                          }`}
                        >
                          {t(`lang.${code}_short`)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Learning Language */}
                  <div className="p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-lg bg-emerald-500/10 text-emerald-500 flex items-center justify-center">
                        <Languages size={14} />
                      </div>
                      <div className="text-xs font-bold text-app-text">{t('settings.learning_lang_label')}</div>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {(['en', 'es', 'de', 'fr', 'it', 'pt', 'ja', 'zh', 'ko'] as const).map((code) => (
                        <button
                          key={code}
                          onClick={() => updateSettings({ learningLanguage: code })}
                          className={`py-2 rounded-xl text-[10px] font-black border transition-all ${
                            settings.learningLanguage === code
                              ? 'bg-app-primary text-app-primary-text border-app-primary shadow-sm'
                              : 'bg-app-bg text-app-hint border-app-border'
                          }`}
                        >
                          {t(`lang.${code}_short`)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              {/* FEEDBACK SECTION */}
              <section className="space-y-4">
                <SectionHeader icon={Sparkles} label={t('settings.section_feedback')} />
                <div className="bg-app-surface border border-app-border rounded-2xl overflow-hidden divide-y divide-app-border">
                  <SettingToggleRow
                    icon={Volume2}
                    label={t('settings.sound_label')}
                    hint={t('settings.sound_hint')}
                    checked={settings.soundEnabled}
                    onChange={(v) => updateSettings({ soundEnabled: v })}
                    onTest={testSound}
                    testLabel={t('settings.test_sound')}
                  />
                  <SettingToggleRow
                    icon={Vibrate}
                    label={t('settings.haptics_label')}
                    hint={t('settings.haptics_hint')}
                    checked={settings.hapticsEnabled}
                    onChange={(v) => updateSettings({ hapticsEnabled: v })}
                    onTest={testHaptics}
                    testLabel={t('settings.test_haptics')}
                  />
                </div>
              </section>

              {/* ADVANCED SECTION */}
              <section className="space-y-4">
                <SectionHeader icon={ArrowLeftRight} label={t('settings.section_advanced')} />
                <div className="bg-app-surface border border-app-border rounded-2xl overflow-hidden divide-y divide-app-border">
                  <SettingToggleRow
                    icon={Headphones}
                    label={t('settings.autoplay_label')}
                    hint={t('settings.autoplay_hint')}
                    checked={settings.autoPronounce}
                    onChange={(v) => updateSettings({ autoPronounce: v })}
                  />
                  <SettingToggleRow
                    icon={ArrowLeftRight}
                    label={t('settings.produce_label', { lang: t(`lang.${settings.learningLanguage}_short`) })}
                    hint={t('settings.produce_hint')}
                    checked={settings.produceDirection}
                    onChange={(v) => updateSettings({ produceDirection: v })}
                  />
                  <SettingToggleRow
                    icon={Mic2}
                    label={t('settings.ai_label')}
                    hint={t('settings.ai_hint')}
                    checked={settings.aiGradingEnabled}
                    onChange={(v) => updateSettings({ aiGradingEnabled: v })}
                  />
                  <SettingToggleRow
                    icon={MessageSquare}
                    label={t('settings.replay_label')}
                    hint={t('settings.replay_hint')}
                    checked={settings.inSessionReplay}
                    onChange={(v) => updateSettings({ inSessionReplay: v })}
                  />
                </div>
              </section>

              {/* VOICE ACCENT */}
              {settings.learningLanguage === 'en' && (
                <section className="space-y-4 pb-12">
                  <SectionHeader icon={Mic2} label={t('settings.section_voice')} />
                  <div className="bg-app-surface border border-app-border rounded-2xl p-4 space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-app-primary/10 text-app-primary flex items-center justify-center">
                        <Mic2 size={16} />
                      </div>
                      <div className="font-semibold text-sm">{t('settings.accent_label')}</div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => updateSettings({ voiceLocale: 'en-US' })}
                        className={`py-3 rounded-xl text-xs font-bold border transition-all ${
                          settings.voiceLocale === 'en-US'
                            ? 'bg-app-primary text-app-primary-text border-app-primary shadow-md'
                            : 'bg-app-bg text-app-hint border-app-border active:bg-app-surface'
                        }`}
                      >
                        {t('settings.accent_us')}
                      </button>
                      <button
                        onClick={() => updateSettings({ voiceLocale: 'en-GB' })}
                        className={`py-3 rounded-xl text-xs font-bold border transition-all ${
                          settings.voiceLocale === 'en-GB'
                            ? 'bg-app-primary text-app-primary-text border-app-primary shadow-md'
                            : 'bg-app-bg text-app-hint border-app-border active:bg-app-surface'
                        }`}
                      >
                        {t('settings.accent_uk')}
                      </button>
                    </div>
                  </div>
                </section>
              )}
            </div>

            {/* Footer */}
            <div className="p-6 pt-3 bg-app-bg border-t border-app-border" style={{ paddingBottom: `calc(1.5rem + var(--tg-safe-area-inset-bottom, 0px))` }}>
              <button
                onClick={onClose}
                className="w-full bg-app-primary text-app-primary-text py-4 rounded-2xl font-black uppercase tracking-widest active:scale-95 transition-transform shadow-lg shadow-app-primary/20"
              >
                {t('common.save')}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function SectionHeader({ icon: Icon, label }: { icon: React.ComponentType<{ size?: number; className?: string }>, label: string }) {
  return (
    <h3 className="text-[10px] uppercase tracking-[0.2em] text-app-hint font-black px-1 flex items-center gap-2">
      <Icon size={12} className="opacity-50" /> {label}
    </h3>
  );
}

function SettingToggleRow({
  icon: Icon,
  label,
  hint,
  checked,
  onChange,
  onTest,
  testLabel,
}: {
  icon: React.ElementType;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  onTest?: (e: React.MouseEvent) => void;
  testLabel?: string;
}) {
  return (
    <div className="p-4 space-y-3">
      <label className="flex items-center justify-between cursor-pointer group">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-app-primary/10 text-app-primary flex items-center justify-center transition-colors group-active:bg-app-primary/20">
            <Icon size={16} />
          </div>
          <div className="min-w-0 pr-2">
            <div className="font-semibold text-sm text-app-text leading-none mb-1.5">{label}</div>
            <div className="text-[10px] text-app-hint font-medium leading-tight line-clamp-1">{hint}</div>
          </div>
        </div>
        <div className="relative shrink-0">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-10 h-6 bg-app-bg border border-app-border rounded-full peer-checked:bg-app-primary peer-checked:border-app-primary transition-all shadow-inner" />
          <div className="absolute left-1 top-1 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-4 shadow-sm" />
        </div>
      </label>
      {onTest && (
        <button 
          onClick={onTest}
          className="w-full flex items-center justify-center gap-2 py-1.5 rounded-lg bg-app-bg text-app-hint text-[10px] font-bold uppercase tracking-wider active:scale-95 transition-transform border border-app-border/50"
        >
          <Play size={10} fill="currentColor" /> {testLabel}
        </button>
      )}
    </div>
  );
}

function ModeOption({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`py-2.5 px-3 text-[11px] font-bold transition-all rounded-xl border ${
        active
          ? 'bg-app-primary text-app-primary-text border-app-primary shadow-md'
          : 'bg-app-bg border-app-border text-app-hint active:bg-app-surface'
      }`}
    >
      {children}
    </button>
  );
}
