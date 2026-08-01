import { describe, expect, it } from 'vitest';
import { shouldRequestRecall } from '@/lib/search/recall-trigger';

describe('shouldRequestRecall', () => {
  it('fires only for settled sparse queries with at least three characters', () => {
    expect(shouldRequestRecall('abc', 0)).toBe(true);
    expect(shouldRequestRecall('semantic query', 4)).toBe(true);
    expect(shouldRequestRecall('ab', 0)).toBe(false);
    expect(shouldRequestRecall('semantic query', 5)).toBe(false);
    expect(shouldRequestRecall('semantic query', Number.NaN)).toBe(false);
  });
});
