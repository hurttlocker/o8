import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverTimingHeaders, totalServerTiming } from './server-timing';

describe('server timing helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a non-negative total duration', () => {
    vi.spyOn(performance, 'now').mockReturnValue(125.25);
    expect(totalServerTiming(100)).toBe('total;dur=25.3');
  });

  it('preserves existing response headers', () => {
    vi.spyOn(performance, 'now').mockReturnValue(100);
    expect(serverTimingHeaders(100, { 'Cache-Control': 'no-store' })).toEqual({
      'Cache-Control': 'no-store',
      'Server-Timing': 'total;dur=0.0',
    });
  });
});
