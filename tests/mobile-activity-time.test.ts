import { describe, expect, it } from 'vitest';
import { formatMobileActivityTime } from '@/lib/mobile/activity-time';

describe('mobile activity timestamps', () => {
  it('preserves the already-relative runtime inventory label', () => {
    expect(formatMobileActivityTime('2m ago')).toBe('2m ago');
  });

  it('formats ISO timestamps without producing undefined time text', () => {
    expect(formatMobileActivityTime(new Date(Date.now() - 120_000).toISOString())).toMatch(/m ago$/);
  });
});
