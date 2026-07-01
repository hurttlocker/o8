/**
 * Targeting difficulty → tier routing — the pure decision (pickTier). Tier→config
 * resolution reads operator settings and is covered by the API smoke.
 */

import { describe, it, expect } from 'vitest';

import type { TargetSignals } from './signals';
import { pickTier } from './routing';

const sig = (over: Partial<TargetSignals>): TargetSignals => ({
  path: 'f.ts', loc: 100, symbolCount: 5, outboundImports: 3, inbound: 0, churn: 0, ...over,
});

describe('pickTier — the "don\'t burn Opus on a rename" table', () => {
  it('small + low-churn → cheap triage tier', () => {
    expect(pickTier(sig({ loc: 40, churn: 0 }))).toBe('triage');
    expect(pickTier(sig({ loc: 149, churn: 2 }))).toBe('triage');
  });

  it('large OR churning → premium action tier', () => {
    expect(pickTier(sig({ loc: 800, churn: 0 }))).toBe('action'); // big
    expect(pickTier(sig({ loc: 40, churn: 9 }))).toBe('action'); // churning
    expect(pickTier(sig({ loc: 150, churn: 0 }))).toBe('action'); // exactly at the LOC threshold
    expect(pickTier(sig({ loc: 40, churn: 3 }))).toBe('action'); // exactly at the churn threshold
  });
});
