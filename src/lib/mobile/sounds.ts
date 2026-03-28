/**
 * sounds.ts — Subtle audio feedback system.
 *
 * Uses Web Audio API to generate tones programmatically.
 * No external audio files needed. Enabled by default and controllable in settings.
 *
 * Inspired by iOS system sounds: short, muted, tasteful.
 */

const SOUND_STORAGE_KEY = 'cortex-ide:sounds';
const SOUND_DEFAULT_ENABLED = true;

let audioCtx: AudioContext | null = null;
let soundEnabled = SOUND_DEFAULT_ENABLED;

function readSoundPreference() {
  if (typeof window === 'undefined') {
    return SOUND_DEFAULT_ENABLED;
  }

  const stored = window.localStorage.getItem(SOUND_STORAGE_KEY)
    ?? window.sessionStorage.getItem(SOUND_STORAGE_KEY);
  if (stored === '1') return true;
  if (stored === '0') return false;
  return SOUND_DEFAULT_ENABLED;
}

function persistSoundPreference(enabled: boolean) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SOUND_STORAGE_KEY, enabled ? '1' : '0');
  window.sessionStorage.setItem(SOUND_STORAGE_KEY, enabled ? '1' : '0');
}

async function getCtx(): Promise<AudioContext | null> {
  if (!soundEnabled) return null;
  if (!audioCtx) {
    try {
      const AudioContextCtor = window.AudioContext
        || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) return null;
      audioCtx = new AudioContextCtor({ latencyHint: 'interactive' });
    } catch {
      return null;
    }
  }
  if (audioCtx.state === 'suspended') {
    try {
      await audioCtx.resume();
    } catch {
      return null;
    }
  }
  return audioCtx;
}

async function playTone(
  frequency: number,
  duration: number,
  type: OscillatorType = 'sine',
  volume = 0.08,
  rampDown = true,
) {
  const ctx = await getCtx();
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
  void playTone(523, 0.15, 'sine', 0.06);
  setTimeout(() => { void playTone(659, 0.2, 'sine', 0.06); }, 120);
}

/** Approval needed — soft knock (two quick taps) */
export function playApprovalNeeded() {
  void playTone(880, 0.06, 'triangle', 0.05);
  setTimeout(() => { void playTone(880, 0.06, 'triangle', 0.05); }, 100);
}

/** Build failed — descending tone */
export function playBuildFailed() {
  void playTone(440, 0.15, 'sine', 0.05);
  setTimeout(() => { void playTone(330, 0.2, 'sine', 0.05); }, 130);
}

/** New message — barely-there tap */
export function playMessageReceived() {
  void playTone(1047, 0.05, 'sine', 0.03);
}

/** Message sent — short upward chirp */
export function playSendClick() {
  void playTone(1320, 0.05, 'triangle', 0.055);
  setTimeout(() => { void playTone(1760, 0.04, 'sine', 0.038); }, 22);
}

/** Enable/disable sounds */
export function setSoundEnabled(enabled: boolean) {
  soundEnabled = enabled;
  persistSoundPreference(enabled);
}

/** Check if sounds are enabled */
export function isSoundEnabled(): boolean {
  return soundEnabled;
}

/** Initialize from stored preference */
export function initSounds() {
  soundEnabled = readSoundPreference();
  persistSoundPreference(soundEnabled);
}
