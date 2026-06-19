import { describe, expect, it } from 'vitest';

import { MANAGED_REALTIME_READY, resolveRealtimeAccessWith } from './realtime-access';

describe('resolveRealtimeAccessWith', () => {
  it('a BYOK key wins regardless of plan — free for everyone', () => {
    const free = resolveRealtimeAccessWith({ hasByokKey: true, proxyInference: false });
    expect(free.mode).toBe('byok');
    expect(free.available).toBe(true);

    // Even a paid account with a key uses BYOK (their key, their bill).
    const paid = resolveRealtimeAccessWith({ hasByokKey: true, proxyInference: true });
    expect(paid.mode).toBe('byok');
    expect(paid.available).toBe(true);
  });

  it('no key + the paid proxy lever resolves to the managed path', () => {
    const managed = resolveRealtimeAccessWith({ hasByokKey: false, proxyInference: true });
    expect(managed.mode).toBe('managed');
    // Availability tracks whether the managed proxy is actually wired yet.
    expect(managed.available).toBe(MANAGED_REALTIME_READY);
    if (!MANAGED_REALTIME_READY) {
      expect(managed.reason).toMatch(/coming|own OpenAI key/i);
    }
  });

  it('no key + no paid lever is locked (needs a key or an upgrade) — capability not withheld, only cost', () => {
    const locked = resolveRealtimeAccessWith({ hasByokKey: false, proxyInference: false });
    expect(locked.mode).toBe('locked');
    expect(locked.available).toBe(false);
    expect(locked.reason).toMatch(/OpenAI key|upgrade/i);
  });
});
