import { describe, expect, it } from 'vitest';
import { planNarrationSpeech } from './narration-speaker';
import type { NarrationDecision, NarrationTier } from './narration-policy';

function decision(
  tier: NarrationTier,
  utterance: string,
  overrides: Partial<NarrationDecision> = {},
): NarrationDecision {
  return {
    sourceEventIds: ['evt-1'],
    agentLabel: 'Checkout packet',
    tier,
    action: 'speak',
    utterance,
    holdUntilPause: tier !== 'interrupt-now',
    estimatedVoiceSeconds: 2,
    valueScore: 50,
    valuePerVoiceSecond: 25,
    budgetWouldExceed: false,
    reason: 'test fixture',
    suppressionReason: null,
    isFleetPointer: false,
    ...overrides,
  };
}

describe('planNarrationSpeech', () => {
  it('maps interrupt-now decisions to an immediate interrupt action', () => {
    const actions = planNarrationSpeech([
      decision('interrupt-now', 'Checkout packet: approval needed.'),
    ]);
    expect(actions).toEqual([
      { utterance: 'Checkout packet: approval needed.', mode: 'interrupt', tier: 'interrupt-now' },
    ]);
  });

  it('maps ambient-rollup and on-demand decisions to queued (pause-respecting) actions', () => {
    const actions = planNarrationSpeech([
      decision('ambient-rollup', 'Checkout packet: merged.'),
      decision('on-demand', "I'm tracking 3 active agents."),
    ]);
    expect(actions).toEqual([
      { utterance: 'Checkout packet: merged.', mode: 'queued', tier: 'ambient-rollup' },
      { utterance: "I'm tracking 3 active agents.", mode: 'queued', tier: 'on-demand' },
    ]);
  });

  it('preserves the ranked input order — the policy already sorted by value-per-voice-second', () => {
    const actions = planNarrationSpeech([
      decision('interrupt-now', 'Checkout packet: failure.'),
      decision('ambient-rollup', 'Billing packet: merged.'),
      decision('interrupt-now', 'Auth packet: conflict.'),
    ]);
    expect(actions.map((a) => a.utterance)).toEqual([
      'Checkout packet: failure.',
      'Billing packet: merged.',
      'Auth packet: conflict.',
    ]);
    expect(actions.map((a) => a.mode)).toEqual(['interrupt', 'queued', 'interrupt']);
  });

  it('drops decisions with an empty utterance', () => {
    const actions = planNarrationSpeech([
      decision('ambient-rollup', '   '),
      decision('interrupt-now', 'Checkout packet: blocked.'),
    ]);
    expect(actions).toEqual([
      { utterance: 'Checkout packet: blocked.', mode: 'interrupt', tier: 'interrupt-now' },
    ]);
  });

  it('returns an empty plan for an empty poll result', () => {
    expect(planNarrationSpeech([])).toEqual([]);
  });
});
