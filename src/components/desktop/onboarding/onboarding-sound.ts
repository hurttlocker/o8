/** Original, low-volume setup cues. Silent until explicitly enabled. */
import { browserProgressStorage, type ProgressStorage } from './onboarding-progress';

export type OnboardingCue = 'tick' | 'advance' | 'complete';

const MUTE_KEY = 'o8:onboarding-muted';

let ctx: AudioContext | null = null;
const activeVoices = new Set<{ osc: OscillatorNode; gain: GainNode }>();
let lastCueAt = -Infinity;

function audioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    if (!ctx || ctx.state === 'closed') {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

export function isOnboardingMuted(storage: ProgressStorage | null = browserProgressStorage()): boolean {
  try {
    return storage?.getItem(MUTE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setOnboardingMuted(muted: boolean, storage: ProgressStorage | null = browserProgressStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(MUTE_KEY, muted ? '1' : '0');
    if (muted) stopOnboardingCues();
    return true;
  } catch {
    return false;
  }
}

/** A single soft sine "voice" with a gentle attack/decay envelope. */
function voice(ac: AudioContext, freq: number, startAt: number, dur: number, peak: number): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  const t0 = ac.currentTime + startAt;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain);
  gain.connect(ac.destination);
  const entry = { osc, gain };
  activeVoices.add(entry);
  osc.onended = () => { activeVoices.delete(entry); osc.disconnect(); gain.disconnect(); };
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Quietly release a cue when it is replaced or muted. */
export function stopOnboardingCues(): void {
  if (!ctx) return;
  const now = ctx.currentTime;
  for (const { osc, gain } of activeVoices) {
    try {
      if (gain.gain.cancelAndHoldAtTime) gain.gain.cancelAndHoldAtTime(now);
      else gain.gain.cancelScheduledValues(now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.012);
      osc.stop(now + 0.02);
    } catch { /* A note may already have ended. */ }
  }
}

/** Play a UI cue. Cheap, fire-and-forget, never throws. */
export function playOnboardingCue(cue: OnboardingCue, storage: ProgressStorage | null = browserProgressStorage()): void {
  if (isOnboardingMuted(storage)) return;
  const ac = audioCtx();
  if (!ac) return;
  if (cue === 'tick' && ac.currentTime - lastCueAt < 0.075) return;
  stopOnboardingCues();
  lastCueAt = ac.currentTime;
  try {
    if (cue === 'tick') {
      voice(ac, 640, 0, 0.045, 0.018);
    } else if (cue === 'advance') {
      // soft two-note rise — a step forward
      voice(ac, 523.25, 0, 0.09, 0.022);
      voice(ac, 783.99, 0.045, 0.12, 0.018);
    } else {
      // complete — a gentle major triad bloom
      voice(ac, 523.25, 0, 0.24, 0.022);
      voice(ac, 659.25, 0.035, 0.25, 0.018);
      voice(ac, 783.99, 0.07, 0.28, 0.016);
    }
  } catch {
    /* ignore */
  }
}
