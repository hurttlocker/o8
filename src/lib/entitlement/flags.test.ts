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
});
