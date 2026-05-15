import { getSettings } from './settings';

// A simple Web Audio API synthesizer for UI sounds. No external assets.

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const { soundEnabled } = getSettings();
  if (!soundEnabled) return null;

  if (!audioCtx) {
    // webkitAudioContext: older Safari prefix. Widen the lookup just enough
    // to avoid an explicit `any`.
    const AudioContextCtor =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (AudioContextCtor) {
      audioCtx = new AudioContextCtor();
    }
  }
  // Mobile autoplay policy: the context starts `suspended` until a user
  // gesture explicitly resumes it. Fire resume() — fine to not await for
  // short oscillator schedules that target ctx.currentTime + delay.
  if (audioCtx && audioCtx.state === 'suspended') {
    void audioCtx.resume().catch(() => {})
  }
  return audioCtx;
}

/**
 * Call once from a user-gesture handler (e.g. "Начать сессию" onClick) to
 * unlock the AudioContext. On Android Chrome / WebView the context starts
 * in `suspended` state and the very first oscillator scheduled from a
 * non-gesture context (like a setTimeout chain) plays silently. Priming
 * inside an onClick fixes that for the whole page session.
 */
export async function primeAudio(): Promise<void> {
  const ctx = getAudioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume()
    } catch {
      // ignored — first play will retry the resume anyway
    }
  }
}

export function playPopSound() {
  const ctx = getAudioContext();
  if (!ctx) return;

  const oscillator = ctx.createOscillator();
  const gainNode = ctx.createGain();

  oscillator.connect(gainNode);
  gainNode.connect(ctx.destination);

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(400, ctx.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(800, ctx.currentTime + 0.05);

  gainNode.gain.setValueAtTime(0, ctx.currentTime);
  gainNode.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 0.02);
  gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);

  oscillator.start(ctx.currentTime);
  oscillator.stop(ctx.currentTime + 0.1);
}

export function playSuccessChime() {
  const ctx = getAudioContext();
  if (!ctx) return;

  // Simple major chord arpeggio
  const frequencies = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
  
  frequencies.forEach((freq, i) => {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type = 'sine';
    
    const startTime = ctx.currentTime + i * 0.08;
    oscillator.frequency.setValueAtTime(freq, startTime);

    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(0.2, startTime + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + 0.6);

    oscillator.start(startTime);
    oscillator.stop(startTime + 0.6);
  });
}

export function playThudSound() {
  const ctx = getAudioContext();
  if (!ctx) return;

  const oscillator = ctx.createOscillator();
  const gainNode = ctx.createGain();

  oscillator.connect(gainNode);
  gainNode.connect(ctx.destination);

  oscillator.type = 'triangle';
  oscillator.frequency.setValueAtTime(150, ctx.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.1);

  gainNode.gain.setValueAtTime(0, ctx.currentTime);
  gainNode.gain.linearRampToValueAtTime(0.4, ctx.currentTime + 0.02);
  gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);

  oscillator.start(ctx.currentTime);
  oscillator.stop(ctx.currentTime + 0.15);
}
