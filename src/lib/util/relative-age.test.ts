import { describe, expect, it } from 'vitest';
import { relativeAge, timestampMillis } from './relative-age';

const now = Date.parse('2026-09-09T12:00:00.000Z');

describe('relative activity age', () => {
  it.each([undefined, null, '', 'not-a-date', 'just now', NaN, Infinity, new Date(NaN)])(
    'marks an unavailable timestamp as unknown (%s)', (timestamp) => {
      expect(timestampMillis(timestamp)).toBeNull();
      expect(relativeAge(timestamp, now)).toBe('unknown');
    },
  );

  it.each([now - 5_000, new Date(now - 5_000), new Date(now - 5_000).toISOString()])(
    'preserves the same instant for epoch milliseconds, Date and ISO inputs (%s)', (timestamp) => {
      expect(timestampMillis(timestamp)).toBe(now - 5_000);
      expect(relativeAge(timestamp, now)).toBe('5s ago');
    },
  );

  it('keeps elapsed units and clamps future timestamps without inventing missing activity', () => {
    expect(relativeAge(now + 60_000, now)).toBe('just now');
    expect(relativeAge(now - 59_000, now)).toBe('59s ago');
    expect(relativeAge(now - 60_000, now)).toBe('1m ago');
    expect(relativeAge(now - 3_600_000, now)).toBe('1h ago');
    expect(relativeAge(now - 86_400_000, now)).toBe('1d ago');
    expect(timestampMillis(0)).toBe(0);
  });
});
