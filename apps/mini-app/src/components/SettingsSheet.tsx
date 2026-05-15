import { Settings, Volume2, Vibrate, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useSettings } from '../lib/settings';

export function SettingsSheet({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { settings, updateSettings } = useSettings();

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
            className="fixed bottom-0 inset-x-0 bg-app-bg rounded-t-3xl p-6 z-50 shadow-[0_-10px_40px_rgba(0,0,0,0.1)] flex flex-col max-w-[500px] mx-auto"
          >
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold flex items-center gap-2">
                <Settings size={20} /> Настройки
              </h2>
              <button onClick={onClose} className="p-2 -mr-2 text-app-hint active:scale-95 transition-transform">
                <X size={20} />
              </button>
            </div>

            <div className="flex flex-col gap-4">
              <label className="flex items-center justify-between p-4 bg-app-surface border border-app-border rounded-2xl active:scale-[0.98] transition-transform">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-app-primary/10 text-app-primary flex items-center justify-center">
                    <Volume2 size={16} />
                  </div>
                  <div>
                    <div className="font-semibold text-app-text">Звуки интерфейса</div>
                    <div className="text-xs text-app-hint">Щелчки и уведомления</div>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={settings.soundEnabled}
                  onChange={(e) => updateSettings({ soundEnabled: e.target.checked })}
                  className="w-10 h-6 rounded-full bg-app-border appearance-none relative checked:bg-app-primary cursor-pointer transition-colors before:content-[''] before:absolute before:w-4 before:h-4 before:bg-white before:rounded-full before:top-1 before:left-1 checked:before:translate-x-4 before:transition-transform"
                />
              </label>

              <label className="flex items-center justify-between p-4 bg-app-surface border border-app-border rounded-2xl active:scale-[0.98] transition-transform">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-app-primary/10 text-app-primary flex items-center justify-center">
                    <Vibrate size={16} />
                  </div>
                  <div>
                    <div className="font-semibold text-app-text">Вибрация</div>
                    <div className="text-xs text-app-hint">Тактильный отклик (Haptics)</div>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={settings.hapticsEnabled}
                  onChange={(e) => updateSettings({ hapticsEnabled: e.target.checked })}
                  className="w-10 h-6 rounded-full bg-app-border appearance-none relative checked:bg-app-primary cursor-pointer transition-colors before:content-[''] before:absolute before:w-4 before:h-4 before:bg-white before:rounded-full before:top-1 before:left-1 checked:before:translate-x-4 before:transition-transform"
                />
              </label>
            </div>
            
            {/* Safe area padding for bottom of screen */}
            <div style={{ height: 'calc(1rem + var(--tg-safe-area-inset-bottom, 0px))' }}></div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
