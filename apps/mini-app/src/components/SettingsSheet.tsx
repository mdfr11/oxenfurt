import { Settings, Volume2, Vibrate, X, Play, Headphones, ArrowLeftRight, Languages, Sparkles, Layout, Globe } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useSettings, type LearningLanguage, type NativeLanguage } from '../lib/settings';
import { hapticFeedback } from '@telegram-apps/sdk';
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
            {/* Header with Safe Area */}
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
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Practice Section */}
              <section className="space-y-3">
                <h3 className="text-[10px] uppercase tracking-widest text-app-hint font-black px-1 flex items-center gap-1.5">
                  <Layout size={12} /> {t('settings.section_practice')}
                </h3>

                <div className="bg-app-surface border border-app-border rounded-2xl p-4 space-y-4 text-app-text">
                  <div className="space-y-2">
                    <div className="text-xs font-bold">{t('settings.mode_label')}</div>
                    <div className="grid grid-cols-2 gap-1.5">
                      <ModeOption active={currentMode === 'mixed'} onClick={() => selectMode('mixed')}>{t('mode.mixed')}</ModeOption>
                      <ModeOption active={currentMode === 'recognition'} onClick={() => selectMode('recognition')}>{t('mode.recognition')}</ModeOption>
                      <ModeOption active={currentMode === 'cloze'} onClick={() => selectMode('cloze')}>{t('mode.cloze')}</ModeOption>
                      <ModeOption active={currentMode === 'translation'} onClick={() => selectMode('translation')}>{t('mode.translation')}</ModeOption>
                      <ModeOption active={currentMode === 'listening'} onClick={() => selectMode('listening')}>{t('mode.listening')}</ModeOption>
                    </div>
                  </div>

                  <div className="h-px bg-app-border mx-[-1rem]" />

                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <div className="text-xs font-bold">{t('settings.size_label')}</div>
                      <div className="text-[10px] text-app-hint font-medium tracking-tight">{t('settings.size_hint')}</div>
                    </div>
                    <div className="flex gap-2">
                      {([null, 10, 20, 30] as const).map((n) => (
                        <button
                          key={n ?? 'all'}
                          onClick={() => selectSessionLimit(n)}
                          className={`flex-1 py-2 rounded-xl border text-xs font-bold transition-all active:scale-95 ${
                            settings.sessionLimit === n
                              ? 'bg-app-primary text-app-primary-text border-app-primary shadow-sm'
                              : 'bg-app-bg text-app-hint border-app-border'
                          }`}
                        >
                          {n === null ? t('settings.size_all') : n}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              {/* Preferences Section */}
              <section className="space-y-3">
                <h3 className="text-[10px] uppercase tracking-widest text-app-hint font-black px-1">{t('settings.section_feedback')}</h3>
                <div className="flex flex-col gap-3">
                  <SettingToggle
                    icon={Volume2}
                    label={t('settings.sound_label')}
                    hint={t('settings.sound_hint')}
                    checked={settings.soundEnabled}
                    onChange={(v) => updateSettings({ soundEnabled: v })}
                    onTest={testSound}
                  />
                  <SettingToggle
                    icon={Vibrate}
                    label={t('settings.haptics_label')}
                    hint={t('settings.haptics_hint')}
                    checked={settings.hapticsEnabled}
                    onChange={(v) => updateSettings({ hapticsEnabled: v })}
                    onTest={testHaptics}
                  />
                </div>
              </section>

              {/* Languages section — distinguishes UI language from the
                  language the user is learning. */}
              <section className="space-y-3">
                <h3 className="text-[10px] uppercase tracking-widest text-app-hint font-black px-1">{t('settings.section_languages')}</h3>
                <div className="bg-app-surface border border-app-border rounded-2xl p-4 space-y-4 text-app-text">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Globe size={14} className="text-app-hint" />
                      <div>
                        <div className="text-xs font-bold">{t('settings.native_lang_label')}</div>
                        <div className="text-[10px] text-app-hint font-medium leading-tight">{t('settings.native_lang_hint')}</div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {(['ru', 'en'] as const satisfies readonly NativeLanguage[]).map((code) => (
                        <button
                          key={code}
                          onClick={() => {
                            updateSettings({ nativeLanguage: code })
                            setLocale(code)
                          }}
                          className={`py-2 rounded-lg text-[11px] font-bold transition-all ${
                            settings.nativeLanguage === code
                              ? 'bg-app-primary text-app-primary-text shadow-sm'
                              : 'bg-app-bg text-app-hint border border-app-border'
                          }`}
                        >
                          {t(`lang.${code}_short`)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="h-px bg-app-border mx-[-1rem]" />
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Languages size={14} className="text-app-hint" />
                      <div>
                        <div className="text-xs font-bold">{t('settings.learning_lang_label')}</div>
                        <div className="text-[10px] text-app-hint font-medium leading-tight">{t('settings.learning_lang_hint')}</div>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {(['en', 'es', 'de', 'fr', 'it', 'pt', 'ja', 'zh', 'ko'] as const satisfies readonly LearningLanguage[]).map((code) => (
                        <button
                          key={code}
                          onClick={() => updateSettings({ learningLanguage: code })}
                          className={`py-2 rounded-lg text-[11px] font-bold transition-all ${
                            settings.learningLanguage === code
                              ? 'bg-app-primary text-app-primary-text shadow-sm'
                              : 'bg-app-bg text-app-hint border border-app-border'
                          }`}
                        >
                          {t(`lang.${code}_short`)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              {/* Advanced Section */}
              <section className="space-y-3">
                <h3 className="text-[10px] uppercase tracking-widest text-app-hint font-black px-1">{t('settings.section_advanced')}</h3>
                <div className="flex flex-col gap-3">
                  <SettingToggle
                    icon={Headphones}
                    label={t('settings.autoplay_label')}
                    hint={t('settings.autoplay_hint')}
                    checked={settings.autoPronounce}
                    onChange={(v) => updateSettings({ autoPronounce: v })}
                  />
                  <SettingToggle
                    icon={ArrowLeftRight}
                    label={t('settings.produce_label', { lang: t(`lang.${settings.learningLanguage}_short`) })}
                    hint={t('settings.produce_hint')}
                    checked={settings.produceDirection}
                    onChange={(v) => updateSettings({ produceDirection: v })}
                  />
                  <SettingToggle
                    icon={Sparkles}
                    label={t('settings.ai_label')}
                    hint={t('settings.ai_hint')}
                    checked={settings.aiGradingEnabled}
                    onChange={(v) => updateSettings({ aiGradingEnabled: v })}
                  />
                  <SettingToggle
                    icon={Layout}
                    label={t('settings.replay_label')}
                    hint={t('settings.replay_hint')}
                    checked={settings.inSessionReplay}
                    onChange={(v: boolean) => updateSettings({ inSessionReplay: v })}
                  />
                </div>
              </section>

              {/* Voice Accent — only meaningful when learning English, hidden otherwise. */}
              {settings.learningLanguage === 'en' && (
                <section className="space-y-3 pb-8">
                  <h3 className="text-[10px] uppercase tracking-widest text-app-hint font-black px-1">{t('settings.section_voice')}</h3>
                  <div className="flex flex-col gap-3 p-4 bg-app-surface border border-app-border rounded-2xl text-app-text">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-app-primary/10 text-app-primary flex items-center justify-center">
                        <Languages size={16} />
                      </div>
                      <div className="font-semibold text-sm">{t('settings.accent_label')}</div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 p-1 bg-app-bg rounded-xl border border-app-border">
                      <button
                        onClick={() => updateSettings({ voiceLocale: 'en-US' })}
                        className={`py-2 rounded-lg text-xs font-bold transition-all ${
                          settings.voiceLocale === 'en-US'
                            ? 'bg-app-primary text-app-primary-text shadow-sm'
                            : 'text-app-hint active:bg-app-surface'
                        }`}
                      >
                        {t('settings.accent_us')}
                      </button>
                      <button
                        onClick={() => updateSettings({ voiceLocale: 'en-GB' })}
                        className={`py-2 rounded-lg text-xs font-bold transition-all ${
                          settings.voiceLocale === 'en-GB'
                            ? 'bg-app-primary text-app-primary-text shadow-sm'
                            : 'text-app-hint active:bg-app-surface'
                        }`}
                      >
                        {t('settings.accent_uk')}
                      </button>
                    </div>
                  </div>
                </section>
              )}
            </div>

            {/* Footer Close Button */}
            <div className="p-6 pt-2 bg-app-bg border-t border-app-border" style={{ paddingBottom: `calc(1.5rem + var(--tg-safe-area-inset-bottom, 0px))` }}>
              <button
                onClick={onClose}
                className="w-full bg-app-primary text-app-primary-text py-4 rounded-2xl font-bold active:scale-95 transition-transform shadow-lg shadow-app-primary/20"
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

function SettingToggle({
  icon: Icon,
  label,
  hint,
  checked,
  onChange,
  onTest,
}: {
  icon: React.ElementType;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  onTest?: (e: React.MouseEvent) => void;
}) {
  const t = useT()
  return (
    <div className="flex flex-col gap-2 p-4 bg-app-surface border border-app-border rounded-2xl active:scale-[0.98] transition-transform text-app-text">
      <label className="flex items-center justify-between cursor-pointer">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-app-primary/10 text-app-primary flex items-center justify-center">
            <Icon size={16} />
          </div>
          <div>
            <div className="font-semibold text-sm">{label}</div>
            <div className="text-[10px] text-app-hint font-medium leading-tight">{hint}</div>
          </div>
        </div>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="w-10 h-6 rounded-full bg-app-border appearance-none relative checked:bg-app-primary cursor-pointer transition-colors before:content-[''] before:absolute before:w-4 before:h-4 before:bg-white before:rounded-full before:top-1 before:left-1 checked:before:translate-x-4 before:transition-transform"
        />
      </label>
      {onTest && (
        <button 
          onClick={onTest}
          className="mt-2 flex items-center justify-center gap-2 py-1.5 px-3 rounded-lg bg-app-bg text-app-hint text-[10px] font-bold uppercase tracking-wider active:scale-95 transition-transform border border-app-border/40"
        >
          <Play size={10} fill="currentColor" /> {label.includes(t('settings.sound_label')) ? t('settings.test_sound') : t('settings.test_haptics')}
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
          ? 'bg-app-primary/10 border-app-primary/30 text-app-primary shadow-sm'
          : 'bg-app-bg border-app-border text-app-hint active:bg-app-surface'
      }`}
    >
      {children}
    </button>
  );
}
