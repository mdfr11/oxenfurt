import { Settings, Volume2, Vibrate, X, Play, Headphones, ArrowLeftRight, Languages, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useSettings } from '../lib/settings';
import { hapticFeedback } from '@telegram-apps/sdk';
import { playPopSound } from '../lib/audio';

export function SettingsSheet({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { settings, updateSettings } = useSettings();

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

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/40 z-40"
          />
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
            className="fixed bottom-0 inset-x-0 bg-app-bg rounded-t-3xl z-50 shadow-[0_-10px_40px_rgba(0,0,0,0.1)] flex flex-col max-w-[500px] mx-auto max-h-[90vh]"
          >
            <div className="flex justify-between items-center p-6 pb-2 text-app-text">
              <h2 className="text-xl font-bold flex items-center gap-2">
                <Settings size={20} className="text-app-primary" /> Настройки
              </h2>
              <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full bg-app-surface border border-app-border text-app-hint shadow-sm active:scale-95 transition-transform" aria-label="Закрыть">
                <X size={18} strokeWidth={2.5} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 pt-2">
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2 p-4 bg-app-surface border border-app-border rounded-2xl active:scale-[0.98] transition-transform text-app-text">
                  <label className="flex items-center justify-between cursor-pointer">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-app-primary/10 text-app-primary flex items-center justify-center">
                        <Volume2 size={16} />
                      </div>
                      <div>
                        <div className="font-semibold text-sm">Звуки интерфейса</div>
                        <div className="text-xs text-app-hint font-medium">Щелчки и уведомления</div>
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.soundEnabled}
                      onChange={(e) => updateSettings({ soundEnabled: e.target.checked })}
                      className="w-10 h-6 rounded-full bg-app-border appearance-none relative checked:bg-app-primary cursor-pointer transition-colors before:content-[''] before:absolute before:w-4 before:h-4 before:bg-white before:rounded-full before:top-1 before:left-1 checked:before:translate-x-4 before:transition-transform"
                    />
                  </label>
                  <button 
                    onClick={testSound}
                    className="mt-2 flex items-center justify-center gap-2 py-1.5 px-3 rounded-lg bg-app-bg text-app-hint text-[10px] font-bold uppercase tracking-wider active:scale-95 transition-transform"
                  >
                    <Play size={12} fill="currentColor" /> Проверить звук
                  </button>
                </div>

                <div className="flex flex-col gap-2 p-4 bg-app-surface border border-app-border rounded-2xl active:scale-[0.98] transition-transform text-app-text">
                  <label className="flex items-center justify-between cursor-pointer">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-app-primary/10 text-app-primary flex items-center justify-center">
                        <Vibrate size={16} />
                      </div>
                      <div>
                        <div className="font-semibold text-sm">Вибрация</div>
                        <div className="text-xs text-app-hint font-medium">Тактильный отклик</div>
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.hapticsEnabled}
                      onChange={(e) => updateSettings({ hapticsEnabled: e.target.checked })}
                      className="w-10 h-6 rounded-full bg-app-border appearance-none relative checked:bg-app-primary cursor-pointer transition-colors before:content-[''] before:absolute before:w-4 before:h-4 before:bg-white before:rounded-full before:top-1 before:left-1 checked:before:translate-x-4 before:transition-transform"
                    />
                  </label>
                  <button 
                    onClick={testHaptics}
                    className="mt-2 flex items-center justify-center gap-2 py-1.5 px-3 rounded-lg bg-app-bg text-app-hint text-[10px] font-bold uppercase tracking-wider active:scale-95 transition-transform"
                  >
                    <Play size={12} fill="currentColor" /> Проверить вибрацию
                  </button>
                </div>

                <div className="flex flex-col gap-2 p-4 bg-app-surface border border-app-border rounded-2xl active:scale-[0.98] transition-transform text-app-text">
                  <label className="flex items-center justify-between cursor-pointer">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-app-primary/10 text-app-primary flex items-center justify-center">
                        <Headphones size={16} />
                      </div>
                      <div>
                        <div className="font-semibold text-sm">Авто-произношение</div>
                        <div className="text-xs text-app-hint font-medium">Озвучивать слово при показе</div>
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.autoPronounce}
                      onChange={(e) => updateSettings({ autoPronounce: e.target.checked })}
                      className="w-10 h-6 rounded-full bg-app-border appearance-none relative checked:bg-app-primary cursor-pointer transition-colors before:content-[''] before:absolute before:w-4 before:h-4 before:bg-white before:rounded-full before:top-1 before:left-1 checked:before:translate-x-4 before:transition-transform"
                    />
                  </label>
                </div>

                <div className="flex flex-col gap-2 p-4 bg-app-surface border border-app-border rounded-2xl active:scale-[0.98] transition-transform text-app-text">
                  <label className="flex items-center justify-between cursor-pointer">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-app-primary/10 text-app-primary flex items-center justify-center">
                        <ArrowLeftRight size={16} />
                      </div>
                      <div>
                        <div className="font-semibold text-sm">Продукция (RU → EN)</div>
                        <div className="text-xs text-app-hint font-medium leading-tight">В «Узнавании» вспоминаешь EN форму</div>
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.produceDirection}
                      onChange={(e) => updateSettings({ produceDirection: e.target.checked })}
                      className="w-10 h-6 rounded-full bg-app-border appearance-none relative checked:bg-app-primary cursor-pointer transition-colors before:content-[''] before:absolute before:w-4 before:h-4 before:bg-white before:rounded-full before:top-1 before:left-1 checked:before:translate-x-4 before:transition-transform"
                    />
                  </label>
                </div>

                <div className="flex flex-col gap-2 p-4 bg-app-surface border border-app-border rounded-2xl active:scale-[0.98] transition-transform text-app-text">
                  <label className="flex items-center justify-between cursor-pointer">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-amber-500/10 text-amber-600 flex items-center justify-center">
                        <Sparkles size={16} fill="currentColor" className="opacity-80" />
                      </div>
                      <div>
                        <div className="font-semibold text-sm">AI-проверка ответов</div>
                        <div className="text-xs text-app-hint font-medium">Кнопка «Проверить смыслом»</div>
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.aiGradingEnabled}
                      onChange={(e) => updateSettings({ aiGradingEnabled: e.target.checked })}
                      className="w-10 h-6 rounded-full bg-app-border appearance-none relative checked:bg-app-primary cursor-pointer transition-colors before:content-[''] before:absolute before:w-4 before:h-4 before:bg-white before:rounded-full before:top-1 before:left-1 checked:before:translate-x-4 before:transition-transform"
                    />
                  </label>
                  <div className="mt-1 text-[10px] text-app-hint leading-relaxed opacity-70 italic">
                    Если LLM не настроен на сервере — кнопка ничего не покажет.
                  </div>
                </div>

                <div className="flex flex-col gap-3 p-4 bg-app-surface border border-app-border rounded-2xl text-app-text">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-app-primary/10 text-app-primary flex items-center justify-center">
                      <Languages size={16} />
                    </div>
                    <div className="font-semibold text-sm">Акцент (Озвучка)</div>
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
                      USA
                    </button>
                    <button
                      onClick={() => updateSettings({ voiceLocale: 'en-GB' })}
                      className={`py-2 rounded-lg text-xs font-bold transition-all ${
                        settings.voiceLocale === 'en-GB'
                          ? 'bg-app-primary text-app-primary-text shadow-sm'
                          : 'text-app-hint active:bg-app-surface'
                      }`}
                    >
                      UK
                    </button>
                  </div>
                </div>
              </div>
              
              {/* Safe area padding for bottom of screen */}
              <div style={{ height: 'calc(1.5rem + var(--tg-safe-area-inset-bottom, 0px))' }}></div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
