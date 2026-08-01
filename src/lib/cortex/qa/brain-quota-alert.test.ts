import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushBrainQuotaAlerts,
  BRAIN_QUOTA_ALERT_COOLDOWN_MS,
  noteBrainQuotaError,
  resetBrainQuotaAlertsForTests,
} from './brain-quota-alert';

describe('Brain subscription quota alerts', () => {
  beforeEach(() => resetBrainQuotaAlertsForTests());

  it('emits one visible cross-house notice instead of per-call spam', () => {
    const emit = vi.fn();
    const error = { code: 'usage_limit_reached', message: 'You have hit your usage limit.' };
    expect(noteBrainQuotaError(error, 'openai')).toBe(true);
    expect(noteBrainQuotaError(error, 'openai')).toBe(false);
    expect(flushBrainQuotaAlerts(emit)).toBe(1);
    expect(flushBrainQuotaAlerts(emit)).toBe(0);
    expect(emit).toHaveBeenCalledWith('alert', expect.objectContaining({
      kind: 'brain_subscription_fallback',
      fromHouse: 'openai',
      toHouse: 'anthropic',
    }));
  });

  it('survives module restart and expires for a later quota cycle', async () => {
    const now = new Date('2026-08-01T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const emit = vi.fn();
    const error = { code: 'usage_limit_reached', message: 'You have hit your usage limit.' };
    expect(noteBrainQuotaError(error, 'openai')).toBe(true);
    expect(flushBrainQuotaAlerts(emit)).toBe(1);

    vi.resetModules();
    const reloaded = await import('./brain-quota-alert');
    expect(reloaded.noteBrainQuotaError(error, 'openai')).toBe(false);

    vi.setSystemTime(now.getTime() + BRAIN_QUOTA_ALERT_COOLDOWN_MS + 1);
    expect(reloaded.noteBrainQuotaError(error, 'openai')).toBe(true);
    expect(reloaded.flushBrainQuotaAlerts(emit)).toBe(1);
    vi.useRealTimers();
  });
});
