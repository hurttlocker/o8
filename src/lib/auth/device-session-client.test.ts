import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deviceSessionDecision, renewDesktopSession, type DeviceSessionDecisionInput } from '@/lib/auth/device-session-client';
import { consumeDesktopAuthCallback, exchangeDesktopAuthTicket, resetConsumedDesktopAuthTicketsForTest, type DesktopAuthClerk, type DesktopAuthSignIn } from '@/lib/auth/desktop-auth-callback';

const owner = 'user_device';
const base: DeviceSessionDecisionInput = {
  nativeMode: true, loaded: true, userId: null, deviceOwner: owner,
  explicitSignOut: false, busy: false, enrolled: false, retryAfter: 0, now: 1_000, trigger: 'initial',
};

afterEach(() => { vi.unstubAllGlobals(); resetConsumedDesktopAuthTicketsForTest(); });

describe('native bridge decisions', () => {
  it.each(['initial', 'focus', 'signed-out'] as const)('renews on %s', (trigger) => {
    expect(deviceSessionDecision({ ...base, trigger })).toBe('renew');
  });
  it.each(['initial', 'focus', 'signed-out'] as const)('backs off for five minutes on %s', (trigger) => {
    expect(deviceSessionDecision({ ...base, trigger, retryAfter: base.now + 300_000 })).toBe('none');
    expect(deviceSessionDecision({ ...base, trigger, retryAfter: base.now, now: base.now + 300_000 })).toBe('renew');
  });
  it('enrolls once per user when missing or owned by another user', () => {
    expect(deviceSessionDecision({ ...base, userId: owner, deviceOwner: null })).toBe('enroll');
    expect(deviceSessionDecision({ ...base, userId: owner, deviceOwner: 'user_other' })).toBe('enroll');
    expect(deviceSessionDecision({ ...base, userId: owner, deviceOwner: null, enrolled: true })).toBe('none');
    expect(deviceSessionDecision({ ...base, userId: owner })).toBe('none');
  });
  it.each([{ nativeMode: false }, { loaded: false }, { busy: true }, { explicitSignOut: true }, { deviceOwner: null }])('does not renew when gated: %j', (overrides) => {
    expect(deviceSessionDecision({ ...base, ...overrides })).toBe('none');
  });
});

describe('ticket exchange through browser callback and device renewal callers', () => {
  function resources() {
    const events: string[] = [];
    const signIn: DesktopAuthSignIn = {
      status: 'complete', createdSessionId: 'session_device',
      ticket: vi.fn(async () => { events.push('ticket'); return {}; }),
      finalize: vi.fn(async () => { events.push('finalize'); return {}; }),
    };
    const clerk: DesktopAuthClerk = {
      setActive: vi.fn(async () => { events.push('activate'); }),
      user: { id: owner, reload: vi.fn(async () => { events.push('reload'); }) },
    };
    const signOut = vi.fn(async () => { events.push('sign-out'); });
    const onSignInComplete = vi.fn(async () => { events.push('clear-marker'); events.push('license-sync'); });
    return { events, signIn, clerk, signOut, onSignInComplete };
  }

  it.each(['callback', 'renewal'] as const)('exchanges, finalizes, activates, then completes through %s', async (caller) => {
    const options = resources();
    const ticket = randomBytes(24).toString('hex');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ticket, clerkUserId: owner })));
    if (caller === 'callback') {
      await consumeDesktopAuthCallback(`o8://auth/callback?ticket=${ticket}&state=nonce`, {
        ...options, getExpectedState: () => 'nonce', clearExpectedState: vi.fn(),
      });
    } else {
      expect(await renewDesktopSession({ ...options, owner, isCurrent: () => true })).toBe(true);
    }
    expect(options.events).toEqual(['ticket', 'finalize', 'activate', 'reload', 'clear-marker', 'license-sync']);
  });

  it('runs full sign-out on an activated session owner mismatch, without syncing', async () => {
    const options = resources();
    options.clerk.user!.id = 'user_other';
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ticket: randomBytes(24).toString('hex'), clerkUserId: owner })));
    expect(await renewDesktopSession({ ...options, owner, isCurrent: () => true })).toBe(false);
    expect(options.signOut).toHaveBeenCalledOnce();
    expect(options.onSignInComplete).not.toHaveBeenCalled();
  });

  it('runs full sign-out on a route owner mismatch before ticket exchange', async () => {
    const options = resources();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ticket: randomBytes(24).toString('hex'), clerkUserId: 'user_other' })));
    expect(await renewDesktopSession({ ...options, owner, isCurrent: () => true })).toBe(false);
    expect(options.signOut).toHaveBeenCalledOnce();
    expect(options.signIn.ticket).not.toHaveBeenCalled();
  });

  it.each([401, 403, 503])('does not activate or sync when renewal is refused with %s', async (status) => {
    const options = resources();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false, reason: 'device_invalid' }, { status })));
    await expect(renewDesktopSession({ ...options, owner, isCurrent: () => true })).rejects.toThrow();
    expect(options.signIn.ticket).not.toHaveBeenCalled();
    expect(options.onSignInComplete).not.toHaveBeenCalled();
  });

  it('ignores renewal that completes after explicit sign-out', async () => {
    const options = resources();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ticket: randomBytes(24).toString('hex'), clerkUserId: owner })));
    expect(await renewDesktopSession({ ...options, owner, isCurrent: () => false })).toBe(false);
    expect(options.signIn.ticket).not.toHaveBeenCalled();
    expect(options.onSignInComplete).not.toHaveBeenCalled();
  });

  it('never exchanges a renewal ticket while a browser ticket exchange is active', async () => {
    const options = resources();
    const browser = resources();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    browser.signIn.ticket = vi.fn(async () => { await hold; return {}; });
    const pending = exchangeDesktopAuthTicket(randomBytes(24).toString('hex'), browser);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ticket: randomBytes(24).toString('hex'), clerkUserId: owner })));
    try {
      expect(await renewDesktopSession({ ...options, owner, isCurrent: () => true })).toBe(false);
      expect(options.signIn.ticket).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
    }
  });
});
