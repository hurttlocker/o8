import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ authError: null as Error | null }));
vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => {
    if (state.authError) throw state.authError;
    return { userId: 'synthetic-user' };
  },
}));
vi.mock('@/lib/db/users', () => ({ findOrCreateByClerk: () => ({ id: 'synthetic', plan: 'free' }) }));

const marker = 'SYNTHETIC_AUTH_SECRET_NOT_VALID';
const secretError = () => Object.assign(new Error(marker), {
  cause: { authorization: marker }, response: { ticket: marker }, stack: marker,
});

function logged(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((args) => args.map((arg) => {
    if (arg instanceof Error) return `${arg.message} ${arg.stack} ${JSON.stringify(arg)}`;
    return typeof arg === 'string' ? arg : JSON.stringify(arg);
  }).join(' ')).join('\n');
}

afterEach(() => {
  state.authError = null;
  vi.restoreAllMocks();
});

describe('residual auth diagnostics', () => {
  it('clerk-provision reports a failure without the SDK error contents', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.authError = secretError();
    const { POST } = await import('@/app/api/panel/auth/clerk-provision/route');

    const response = await POST(new Request('http://127.0.0.1/api/panel/auth/clerk-provision', { method: 'POST' }));

    await expect(response.json()).resolves.toEqual({ ok: false, reason: 'error' });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(logged(errors)).not.toContain(marker);
  });

  it('account settings failures log fixed text for sync and async SDK errors', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { openAccountSettings } = await import('@/lib/auth/open-account-settings');

    openAccountSettings({ openUserProfile: () => { throw secretError(); } });
    openAccountSettings({ openUserProfile: () => Promise.reject(secretError()) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toHaveBeenCalledTimes(2);
    expect(logged(errors)).not.toContain(marker);
    expect(errors.mock.calls.every((args) => args.length === 1
      && args[0] === '[auth] failed to open account settings')).toBe(true);
  });

  it('account settings opens normally without diagnostics', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const open = vi.fn();
    const { openAccountSettings } = await import('@/lib/auth/open-account-settings');

    openAccountSettings({ openUserProfile: open });

    expect(open).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });
});
