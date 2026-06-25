/**
 * onboarding-sound — tiny, tasteful audio cues for the onboarding flow (the
 * CAP-style "magic" the operator liked). Synthesized via Web Audio (no asset
 * files to bundle), so it ships self-contained. Swap in real samples later by
 * pointing playSample() at an <audio> if we want a richer bed.
 *
 * Gating: silent when muted (localStorage `o8:onboarding-muted`) or when the
 * user prefers reduced motion. One lazy shared AudioContext, resumed on the
 * first click gesture (which is always how the first cue fires).
 */

export type OnboardingCue = 'tick' | 'advance' | 'complete';

const MUTE_KEY = 'o8:onboarding-muted';

let ctx: AudioContext | null = null;

function audioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    if (!ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

export function isOnboardingMuted(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.localStorage.getItem(MUTE_KEY) === '1') return true;
  } catch {
    /* ignore */
  }
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export function setOnboardingMuted(muted: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    /* ignore */
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
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Play a UI cue. Cheap, fire-and-forget, never throws. */
export function playOnboardingCue(cue: OnboardingCue): void {
  if (isOnboardingMuted()) return;
  const ac = audioCtx();
  if (!ac) return;
  try {
    if (cue === 'tick') {
      voice(ac, 528, 0, 0.14, 0.05);
    } else if (cue === 'advance') {
      // soft two-note rise — a step forward
      voice(ac, 523.25, 0, 0.16, 0.055); // C5
      voice(ac, 783.99, 0.07, 0.2, 0.045); // G5
    } else {
      // complete — a gentle major triad bloom
      voice(ac, 523.25, 0, 0.5, 0.05); // C5
      voice(ac, 659.25, 0.06, 0.5, 0.045); // E5
      voice(ac, 783.99, 0.12, 0.55, 0.045); // G5
    }
  } catch {
    /* ignore */
  }
}
