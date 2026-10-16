import { describe, expect, it } from 'vitest';
import { isPiAllowanceMessage, PI_ALLOWANCE_EXHAUSTED_MESSAGE, piAllowanceExhaustedMessage } from './transport';

describe('Pi allowance messages', () => {
  it('lets through every message the formatter produces', () => {
    const start = Date.UTC(2026, 0, 1);
    for (let hour = 0; hour < 366 * 24; hour += 7) {
      const resetsAt = new Date(start + hour * 3_600_000 + (hour % 60) * 60_000).toISOString();
      for (const period of ['day', 'week', undefined]) {
        expect(isPiAllowanceMessage(piAllowanceExhaustedMessage({ period, resetsAt }))).toBe(true);
      }
    }
    expect(isPiAllowanceMessage(piAllowanceExhaustedMessage({ period: 'week' }))).toBe(true);
    expect(isPiAllowanceMessage(piAllowanceExhaustedMessage())).toBe(true);
    expect(piAllowanceExhaustedMessage({ period: 'day', resetsAt: 'not a date' })).toBe(PI_ALLOWANCE_EXHAUSTED_MESSAGE);
  });

  it.each([
    'Your daily o8 model allowance is used up. It resets Tuesday, February 99 at 99:99 UTC.',
    'Your weekly o8 model allowance is used up. It resets Tuesday, February 0 at 12:00 UTC.',
    'Your weekly o8 model allowance is used up. It resets Tuesday, February 3 at 24:00 UTC.',
    'Your weekly o8 model allowance is used up. It resets Tuesday, February 3 at 12:60 UTC.',
    'Your daily o8 model allowance is used up. It resets Monday at 00:00 UTC.',
    'Your weekly o8 model allowance is used up. It resets at midnight UTC.',
    'Your o8 model allowance is used up. It resets at midnight UTC.',
    'Your weekly o8 model allowance is used up. It resets Funday, February 3 at 12:00 UTC.',
  ])('refuses text the formatter never writes: %s', (text) => {
    expect(isPiAllowanceMessage(text)).toBe(false);
  });
});
