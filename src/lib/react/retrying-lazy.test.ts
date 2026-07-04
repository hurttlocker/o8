import { describe, expect, it } from 'vitest';
import { loadWithRetries } from './retrying-lazy';

describe('loadWithRetries', () => {
  it('resolves when a failing import factory succeeds on a retry', async () => {
    let attempts = 0;

    const result = await loadWithRetries(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('transient chunk fetch failure');
      }
      return { default: 'loaded' };
    }, { retries: 2, delayMs: 0 });

    expect(result).toEqual({ default: 'loaded' });
    expect(attempts).toBe(2);
  });

  it('rejects after exhausting retries for an always-failing import factory', async () => {
    let attempts = 0;
    const failure = new Error('chunk unavailable');

    await expect(loadWithRetries(async () => {
      attempts += 1;
      throw failure;
    }, { retries: 2, delayMs: 0 })).rejects.toBe(failure);

    expect(attempts).toBe(3);
  });
});
