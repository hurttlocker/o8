/**
 * Answer-cache key normalization (2026-06-11 brain perf pass). The classifier
 * cache always normalized its key; the answer cache didn't — so trivially
 * rephrased duplicates ("What's the ceiling?" vs "what's the ceiling?") each
 * paid the full pipeline.
 */

import { describe, expect, it } from 'vitest';

import { normalizeQuestionForCache } from '@/lib/cortex/qa/ask';

describe('normalizeQuestionForCache', () => {
  it('lowercases and trims', () => {
    expect(normalizeQuestionForCache('  What IS the File Ceiling? '))
      .toBe('what is the file ceiling?');
  });

  it('collapses internal whitespace runs (spaces, tabs, newlines)', () => {
    expect(normalizeQuestionForCache('what\tis  the\n file ceiling?'))
      .toBe('what is the file ceiling?');
  });

  it('maps trivially-rephrased duplicates to the same key', () => {
    const a = normalizeQuestionForCache('What testing framework does this repo use?');
    const b = normalizeQuestionForCache('  what testing   framework does this repo use?');
    expect(a).toBe(b);
  });
});
