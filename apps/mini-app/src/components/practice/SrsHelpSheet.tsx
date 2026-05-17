// Explanatory sheet that pops up from the FSRS-help button on the
// rating row. Pure content — explains what Again / Hard / Good / Easy
// do to the next interval. SettingsSheet-bespoke shell (different
// rounding + z-index) so we don't reuse BottomSheet.

import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, X } from 'lucide-react'
import { useT } from '../../lib/i18n/useT'

interface SrsHelpSheetProps {
  isOpen: boolean
  onClose: () => void
}

export function SrsHelpSheet({ isOpen, onClose }: SrsHelpSheetProps) {
  const t = useT()
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/40 z-50"
          />
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
            className="fixed bottom-0 inset-x-0 bg-app-bg rounded-t-3xl p-6 z-[60] shadow-[0_-10px_40px_rgba(0,0,0,0.1)] flex flex-col max-w-[500px] mx-auto text-app-text"
          >
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold flex items-center gap-2">
                <Sparkles size={20} className="text-amber-500" fill="currentColor" />{' '}
                {t('practice.intervals_title')}
              </h2>
              <button
                onClick={onClose}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-app-surface border border-app-border text-app-hint shadow-sm active:scale-95 transition-transform"
                aria-label={t('common.close')}
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4 text-sm leading-relaxed">
              <p>{t('practice.intervals_intro')}</p>
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-3 bg-app-surface border border-app-border p-4 rounded-2xl">
                <span className="font-bold text-rose-600 dark:text-rose-400">{t('practice.rating_again')}</span>
                <span>{t('practice.intervals_again_desc')}</span>

                <span className="font-bold text-orange-600 dark:text-orange-400">{t('practice.rating_hard')}</span>
                <span>{t('practice.intervals_hard_desc')}</span>

                <span className="font-bold text-blue-600 dark:text-blue-400">{t('practice.rating_good')}</span>
                <span>{t('practice.intervals_good_desc')}</span>

                <span className="font-bold text-emerald-600 dark:text-emerald-400">{t('practice.rating_easy')}</span>
                <span>{t('practice.intervals_easy_desc')}</span>
              </div>
              <p className="text-app-hint text-xs italic mt-2">{t('practice.intervals_footer')}</p>
            </div>

            <button
              onClick={onClose}
              className="w-full bg-app-primary text-app-primary-text py-4 rounded-2xl font-bold mt-6 active:scale-95 transition-transform shadow-lg shadow-app-primary/20"
            >
              {t('practice.intervals_btn_ok')}
            </button>

            <div style={{ height: 'calc(1rem + var(--tg-safe-area-inset-bottom, 0px))' }} />
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
