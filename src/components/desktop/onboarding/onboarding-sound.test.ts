// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.resetModules(); });
it('creates no audio resources until explicit opt-in, then releases each note', async () => {
  const voices: Array<{ connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; frequency: { value: number }; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onended: (() => void) | null }> = [];
  const gains: Array<{ disconnect: ReturnType<typeof vi.fn>; gain: { setValueAtTime: ReturnType<typeof vi.fn>; exponentialRampToValueAtTime: ReturnType<typeof vi.fn> } }> = [];
  const ctor = vi.fn(function () { return { state: 'running', currentTime: 0, destination: {}, createOscillator: () => { const node = { connect: vi.fn(), disconnect: vi.fn(), frequency: { value: 0 }, start: vi.fn(), stop: vi.fn(), onended: null }; voices.push(node); return node; }, createGain: () => { const node = { connect: vi.fn(), disconnect: vi.fn(), gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() } }; gains.push(node); return node; } }; });
  vi.stubGlobal('AudioContext', ctor);
  const sound = await import('./onboarding-sound');
  expect(sound.isOnboardingMuted(localStorage)).toBe(true);
  sound.playOnboardingCue('tick', localStorage);
  expect(ctor).not.toHaveBeenCalled();
  expect(sound.setOnboardingMuted(false, localStorage)).toBe(true);
  sound.playOnboardingCue('tick', localStorage);
  expect(ctor).toHaveBeenCalledOnce();
  expect(voices[0]?.stop).toHaveBeenCalledOnce();
  voices[0]?.onended?.();
  expect(voices[0]?.disconnect).toHaveBeenCalledOnce();
  expect(gains[0]?.disconnect).toHaveBeenCalledOnce();
  sound.setOnboardingMuted(true, localStorage);
  sound.playOnboardingCue('complete', localStorage);
  expect(voices).toHaveLength(1);
});

it('fails silent when the preference store is blocked', async () => {
  const sound = await import('./onboarding-sound');
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: vi.fn() };
  expect(sound.isOnboardingMuted(blocked)).toBe(true);
  expect(sound.setOnboardingMuted(false, blocked)).toBe(false);
  expect(() => sound.playOnboardingCue('advance', blocked)).not.toThrow();
});

it('prevents rapid clicks from stacking volume and silences an active cue on mute', async () => {
  const voices: Array<{ stop: ReturnType<typeof vi.fn>; onended: (() => void) | null }> = [];
  const release = vi.fn();
  const ctor = vi.fn(function () { return {
    state: 'running', currentTime: 0, destination: {},
    createOscillator: () => { const node = { connect: vi.fn(), disconnect: vi.fn(), frequency: { value: 0 }, start: vi.fn(), stop: vi.fn(), onended: null }; voices.push(node); return node; },
    createGain: () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: release, cancelAndHoldAtTime: vi.fn() } }),
  }; });
  vi.stubGlobal('AudioContext', ctor);
  const sound = await import('./onboarding-sound');
  sound.setOnboardingMuted(false, localStorage);
  for (let i = 0; i < 12; i++) sound.playOnboardingCue('tick', localStorage);
  expect(voices).toHaveLength(1);
  const scheduledStop = voices[0]!.stop.mock.calls.length;
  sound.setOnboardingMuted(true, localStorage);
  expect(voices[0]!.stop.mock.calls.length).toBeGreaterThan(scheduledStop);
  expect(release).toHaveBeenLastCalledWith(0.0001, expect.any(Number));
  sound.playOnboardingCue('complete', localStorage);
  expect(voices).toHaveLength(1);
});
