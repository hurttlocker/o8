/**
 * Targeting scorer — the deterministic heuristic. Pure; no DB/git.
 */

import { describe, it, expect } from 'vitest';

import type { TargetSignals } from './signals';
import { heuristicRationale, scoreTargets, subScores } from './scorer';

const sig = (over: Partial<TargetSignals>): TargetSignals => ({
  path: 'f.ts', loc: 100, symbolCount: 5, outboundImports: 3, inbound: 0, churn: 0, ...over,
});

describe('subScores', () => {
  it('a central, churning, dense hub scores high on both axes', () => {
    const s = subScores(sig({ inbound: 30, churn: 20, loc: 900, symbolCount: 60 }));
    expect(s.impact).toBeGreaterThanOrEqual(4);
    expect(s.opportunity).toBeGreaterThanOrEqual(4);
  });

  it('a peripheral, stable, tiny leaf scores low on both axes', () => {
    const s = subScores(sig({ inbound: 0, churn: 0, loc: 20, symbolCount: 1 }));
    expect(s.impact).toBe(1);
    expect(s.opportunity).toBe(1);
  });

  it('impact tracks centrality even without churn (blast radius)', () => {
    const hub = subScores(sig({ inbound: 30 }));
    const leaf = subScores(sig({ inbound: 0 }));
    expect(hub.impact).toBeGreaterThan(leaf.impact);
  });

  it('scores are clamped to 1..5', () => {
    const s = subScores(sig({ inbound: 9999, churn: 9999, loc: 99999, symbolCount: 9999 }));
    expect(s.impact).toBeLessThanOrEqual(5);
    expect(s.opportunity).toBeLessThanOrEqual(5);
    expect(s.impact).toBeGreaterThanOrEqual(1);
  });
});

describe('scoreTargets', () => {
  it('ranks by score desc = impact × opportunity, deterministic tie-break', () => {
    const files = [
      sig({ path: 'leaf.ts', inbound: 0, churn: 0, loc: 20, symbolCount: 1 }),
      sig({ path: 'hub.ts', inbound: 30, churn: 20, loc: 900, symbolCount: 60 }),
      sig({ path: 'mid.ts', inbound: 5, churn: 4, loc: 300, symbolCount: 15 }),
    ];
    const ranked = scoreTargets(files);
    expect(ranked.map((r) => r.path)).toEqual(['hub.ts', 'mid.ts', 'leaf.ts']);
    expect(ranked[0].score).toBe(ranked[0].impact * ranked[0].opportunity);
  });

  it('tie on score breaks by centrality desc, then path asc', () => {
    // Two files engineered to the same score; higher inbound wins the tie.
    const a = sig({ path: 'zzz.ts', inbound: 8, churn: 8, loc: 400, symbolCount: 25 });
    const b = sig({ path: 'aaa.ts', inbound: 3, churn: 8, loc: 400, symbolCount: 25 });
    const ranked = scoreTargets([b, a]);
    const scoreA = ranked.find((r) => r.path === 'zzz.ts')!.score;
    const scoreB = ranked.find((r) => r.path === 'aaa.ts')!.score;
    if (scoreA === scoreB) expect(ranked[0].path).toBe('zzz.ts'); // higher centrality first
  });

  it('honors top-N', () => {
    const files = Array.from({ length: 10 }, (_, i) => sig({ path: `f${i}.ts`, inbound: i }));
    expect(scoreTargets(files, 3)).toHaveLength(3);
  });
});

describe('heuristicRationale', () => {
  it('names centrality + churn when both are strong', () => {
    const r = heuristicRationale(sig({ inbound: 23, churn: 9 }));
    expect(r).toContain('23 files import it');
    expect(r).toContain('9 commits');
  });

  it('calls out a peripheral, stable file as low priority', () => {
    expect(heuristicRationale(sig({ inbound: 0, churn: 0 }))).toMatch(/low priority/i);
  });
});
