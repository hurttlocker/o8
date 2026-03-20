/**
 * sounds.ts — Subtle audio feedback system.
 *
 * Uses Web Audio API to generate tones programmatically.
 * No external audio files needed. Muted by default, opt-in via settings.
 *
 * Inspired by iOS system sounds: short, muted, tasteful.
 */

let audioCtx: AudioContext | null = null;
let soundEnabled = false;

function getCtx(): AudioContext | null {
  if (!soundEnabled) return null;
  if (!audioCtx) {
    try {
      audioCtx = new AudioContext();
    } catch {
      return null;
    }
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function playTone(
  frequency: number,
  duration: number,
  type: OscillatorType = 'sine',
  volume = 0.08,
  rampDown = true,
) {
  const ctx = getCtx();
  if (!ctx) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(frequency, ctx.currentTime);
  gain.gain.setValueAtTime(volume, ctx.currentTime);

  if (rampDown) {
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  }

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
}

/** Agent completed its task — gentle ascending chime */
export function playAgentComplete() {
  playTone(523, 0.15, 'sine', 0.06);
  setTimeout(() => playTone(659, 0.2, 'sine', 0.06), 120);
}

/** Approval needed — soft knock (two quick taps) */
export function playApprovalNeeded() {
  playTone(880, 0.06, 'triangle', 0.05);
  setTimeout(() => playTone(880, 0.06, 'triangle', 0.05), 100);
}

/** Build failed — descending tone */
export function playBuildFailed() {
  playTone(440, 0.15, 'sine', 0.05);
  setTimeout(() => playTone(330, 0.2, 'sine', 0.05), 130);
}

/** New message — barely-there tap */
export function playMessageReceived() {
  playTone(1047, 0.05, 'sine', 0.03);
}

/** Enable/disable sounds */
export function setSoundEnabled(enabled: boolean) {
  soundEnabled = enabled;
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.setItem('cortex-ide:sounds', enabled ? '1' : '0');
  }
}

/** Check if sounds are enabled */
export function isSoundEnabled(): boolean {
  return soundEnabled;
}

/** Initialize from stored preference */
export function initSounds() {
  if (typeof sessionStorage !== 'undefined') {
    soundEnabled = sessionStorage.getItem('cortex-ide:sounds') === '1';
  }
}
