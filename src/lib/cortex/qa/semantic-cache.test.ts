/**
 * Semantic answer cache math (#1226, 2026-06-11). The scan is a dot product
 * over unit vectors with a conservative 0.95 floor — a wrong reuse is worse
 * than a re-ask.
 */

import { describe, expect, it } from 'vitest';

import { findSemanticMatch } from '@/lib/cortex/qa/ask';
import { dot, unitNormalize } from '@/lib/cortex/qa/llm/gemini-embed';

describe('unitNormalize + dot', () => {
  it('normalizes to unit length', () => {
    const v = unitNormalize([3, 4]);
    expect(v).not.toBeNull();
    expect(Math.hypot(...(v as number[]))).toBeCloseTo(1, 6);
  });

  it('rejects zero vectors', () => {
    expect(unitNormalize([0, 0, 0])).toBeNull();
  });

  it('dot of identical unit vectors is 1', () => {
    const v = unitNormalize([1, 2, 3]) as number[];
    expect(dot(v, v)).toBeCloseTo(1, 6);
  });
});

describe('findSemanticMatch', () => {
  const base = unitNormalize([1, 0, 0]) as number[];
  const near = unitNormalize([1, 0.05, 0]) as number[];   // cos ≈ 0.9988
  const far = unitNormalize([1, 1, 0]) as number[];       // cos ≈ 0.707

  it('matches a near-duplicate above the threshold', () => {
    const match = findSemanticMatch(base, [{ key: 'a', vector: near }]);
    expect(match?.key).toBe('a');
    expect(match!.score).toBeGreaterThan(0.95);
  });

  it('rejects below the threshold', () => {
    expect(findSemanticMatch(base, [{ key: 'b', vector: far }])).toBeNull();
  });

  it('returns the best of several candidates', () => {
    const match = findSemanticMatch(base, [
      { key: 'far', vector: far },
      { key: 'near', vector: near },
      { key: 'exact', vector: base },
    ]);
    expect(match?.key).toBe('exact');
  });

  it('empty candidates → null', () => {
    expect(findSemanticMatch(base, [])).toBeNull();
  });
});
