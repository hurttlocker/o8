import { describe, expect, it } from 'vitest';
import {
  consumeVoiceBudget,
  remainingVoiceSeconds,
  spentVoiceSeconds,
  valuePerVoiceSecond,
  voiceBudgetRemainingRatio,
  wouldExceedVoiceBudget,
  type VoiceBudgetState,
} from './voice-budget';

const HOUR = 60 * 60 * 1_000;

describe('voice budget', () => {
  it('accounts only for spends inside the injected rolling window', () => {
    const state: VoiceBudgetState = {
      limitSeconds: 300,
      windowMs: 5 * HOUR,
      nowMs: 10 * HOUR,
      spends: [
        { atMs: 4 * HOUR, seconds: 200, reason: 'expired' },
        { atMs: 8 * HOUR, seconds: 90, reason: 'active' },
      ],
    };

    expect(spentVoiceSeconds(state)).toBe(90);
    expect(remainingVoiceSeconds(state)).toBe(210);
    expect(voiceBudgetRemainingRatio(state)).toBe(0.7);
    expect(wouldExceedVoiceBudget(state, 211)).toBe(true);
    expect(wouldExceedVoiceBudget(state, 210)).toBe(false);
  });

  it('consumes immutably and exposes value per spoken second', () => {
    const state: VoiceBudgetState = {
      limitSeconds: 60,
      windowMs: 5 * HOUR,
      nowMs: 10 * HOUR,
      spends: [],
    };
    const consumed = consumeVoiceBudget(state, 12, 'review-ready');

    expect(state.spends).toEqual([]);
    expect(remainingVoiceSeconds(consumed)).toBe(48);
    expect(consumed.spends).toEqual([
      { atMs: 10 * HOUR, seconds: 12, reason: 'review-ready' },
    ]);
    expect(valuePerVoiceSecond(90, 3)).toBe(30);
  });
});

