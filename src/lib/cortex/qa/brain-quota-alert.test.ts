import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushBrainQuotaAlerts,
  noteBrainQuotaError,
  resetBrainQuotaAlertsForTests,
} from './brain-quota-alert';

describe('Brain subscription quota alerts', () => {
  beforeEach(() => resetBrainQuotaAlertsForTests());

  it('emits one visible cross-house notice instead of per-call spam', () => {
    const emit = vi.fn();
    expect(noteBrainQuotaError('usage_limit_reached: reset next week', 'openai')).toBe(true);
    expect(noteBrainQuotaError('usage_limit_reached: reset next week', 'openai')).toBe(false);
    expect(flushBrainQuotaAlerts(emit)).toBe(1);
    expect(flushBrainQuotaAlerts(emit)).toBe(0);
    expect(emit).toHaveBeenCalledWith('alert', expect.objectContaining({
      kind: 'brain_subscription_fallback',
      fromHouse: 'openai',
      toHouse: 'anthropic',
    }));
  });
});
