// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ generation: 1, open: vi.fn() }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true }));
vi.mock('@/lib/desktop/open-external', () => ({ openExternalUrl: state.open }));
vi.mock('@/lib/auth/desktop-auth-callback', () => ({ desktopAuthHandoffGeneration: () => state.generation }));
import { startDesktopSignIn } from './start-desktop-sign-in';
import { clearDesktopAuthError, getDesktopAuthError } from './desktop-auth-error';
describe('native sign-in launch', () => {
  beforeEach(() => { state.generation++; state.open.mockClear(); sessionStorage.clear(); clearDesktopAuthError(); });
  afterEach(() => vi.unstubAllGlobals());
  it('deduplicates concurrent begin calls and preserves the existing nonce callback', async () => {
    let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
    const fetch = vi.fn(async (_input: string) => { await pending; return { ok: true, json: async () => ({ ok: true, state: 'server-state' }) }; }); vi.stubGlobal('fetch', fetch);
    const first = startDesktopSignIn(); const second = startDesktopSignIn(); expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe('/api/panel/auth/handoff?action=begin'); release(); await Promise.all([first, second]);
    expect(state.open).toHaveBeenCalledOnce(); const url = new URL(state.open.mock.calls[0][0]); expect(url.searchParams.get('state')).toBe('server-state'); expect(url.searchParams.get('redirect_uri')).toBe('o8://auth/callback');
  });
  it('never opens a cancelled generation and shows only a sanitized failure', async () => {
    let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => { await pending; return { ok: true, json: async () => ({ ok: true, state: 'old-state' }) }; }));
    const first = startDesktopSignIn(); state.generation++; release(); await first; expect(state.open).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('sensitive upstream data'); })); await startDesktopSignIn();
    expect(getDesktopAuthError()?.message).toBe('Sign-in could not be started. Try again.'); expect(state.open).not.toHaveBeenCalled();
  });
});
