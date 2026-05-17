import type { ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

interface BottomSheetProps {
  /** Mounts and animates the sheet in. Falsy → animates out and unmounts. */
  isOpen: boolean
  /** Fires on backdrop click. Each consumer also has its own close button
   *  inside `children` — both paths must call the same handler. */
  onClose: () => void
  /** Tailwind-arbitrary max-height for the panel. Default 90vh matches
   *  what most sheets used; RelatedCardsSheet wanted 75vh to leave room
   *  to peek at the underlying card. */
  maxHeight?: string
  children: ReactNode
}

// Shared bottom-sheet shell — backdrop, slide-in animation, max-width
// cap for tablet/desktop, and the spring transition. Replaces three
// near-identical copies that lived in QuestionSheet, EditCardSheet,
// and RelatedCardsSheet. SettingsSheet has its own bespoke shell
// (different rounding, z-index, scroll model) and stays standalone.
//
// Children own their own header + close button — those varied enough
// per sheet that a `title` prop felt forced.
export function BottomSheet({ isOpen, onClose, maxHeight = '90vh', children }: BottomSheetProps) {
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
            style={{ maxHeight }}
            className="fixed bottom-0 inset-x-0 bg-app-bg rounded-t-3xl p-6 z-50 shadow-[0_-10px_40px_rgba(0,0,0,0.1)] flex flex-col max-w-[500px] mx-auto overflow-y-auto"
          >
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
