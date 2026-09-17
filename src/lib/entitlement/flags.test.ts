import { describe, expect, it } from 'vitest';

import { isPaidPlan, resolveFlags } from './flags';

describe('paid plan predicate', () => {
  it.each([
    ['free', false],
    ['pro', true],
    ['team', true],
    ['founder', true],
  ] as const)('classifies %s consistently', (plan, paid) => {
    expect(isPaidPlan(plan)).toBe(paid);
    expect(resolveFlags(plan)['proxy.inference']).toBe(paid);
  });

  it.each([
    ['free', false],
    ['pro', true],
    ['team', true],
    ['founder', true],
  ] as const)('gates the live voice brain behind a paid plan for %s', (plan, paid) => {
    expect(resolveFlags(plan)['voice.liveBrain']).toBe(paid);
    // One name for the gate: the phone mint reads this flag, never the plan.
    expect(resolveFlags(plan)['voice.liveBrain']).toBe(isPaidPlan(plan));
  });
});
