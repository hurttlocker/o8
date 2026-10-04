// @vitest-environment jsdom
import { randomBytes } from 'node:crypto';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeDesktopAuthCallback, resetConsumedDesktopAuthTicketsForTest } from '@/lib/auth/desktop-auth-callback';
import type { O8AuthState } from '@/components/auth/O8AuthProvider';

const mocks = vi.hoisted(() => ({
  signedIn: false,
  user: null as { id: string; reload: () => Promise<void> } | null,
  clerk: {} as Record<string, unknown>,
  signIn: {} as Record<string, unknown>,
  purge: vi.fn(async () => {}),
}));
vi.mock('@clerk/nextjs', () => ({
  ClerkProvider: ({ children }: { children: unknown }) => children,
  useUser: () => ({ isLoaded: true, isSignedIn: mocks.signedIn, user: mocks.user }),
  useClerk: () => mocks.clerk,
  useSignIn: () => ({ signIn: mocks.signIn }),
}));
vi.mock('tauri-plugin-clerk', () => ({ initClerk: async () => ({}) }));
vi.mock('@/components/auth/DesktopAuthCallbackHandler', () => ({ DesktopAuthCallbackHandler: () => null }));
vi.mock('@/lib/auth/clerk-fetch-guard', () => ({ installTauriClerkFetchGuard: () => {} }));
vi.mock('@/lib/auth/start-desktop-sign-in', () => ({ startDesktopSignIn: vi.fn() }));
vi.mock('@/lib/auth/tauri-clerk-store', async (original) => ({
  ...await original<typeof import('@/lib/auth/tauri-clerk-store')>(), purgeTauriClerkStore: mocks.purge,
}));

const owner = 'user_device';
let root: Root;
let authState: O8AuthState;
let render: () => void;
let fetchMock: ReturnType<typeof vi.fn>;
let events: string[];
let present: boolean;
let renewStatus: number;

async function focus() {
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(400);
  });
}

async function mount(nativeMode = true) {
  if (nativeMode) Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  const { O8AuthProvider, useO8Auth } = await import('@/components/auth/O8AuthProvider');
  const Probe = () => {
    const state = useO8Auth();
    useEffect(() => { authState = state; }, [state]);
    return null;
  };
  render = () => root.render(createElement(O8AuthProvider, null, createElement(Probe)));
  await act(async () => { render(); });
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  root = createRoot(document.createElement('div'));
  mocks.signedIn = false;
  mocks.user = null;
  mocks.purge.mockClear();
  events = [];
  present = true;
  renewStatus = 200;
  const ticket = randomBytes(24).toString('hex');
  mocks.clerk = {
    user: null,
    session: { getToken: async () => randomBytes(24).toString('hex') },
    setActive: vi.fn(async () => {
      events.push('activate');
      mocks.signedIn = true;
      mocks.user = { id: owner, reload: async () => {} };
      mocks.clerk.user = mocks.user;
      render();
    }),
    signOut: vi.fn(async () => {
      events.push('end-session');
      mocks.signedIn = false;
      mocks.user = null;
      mocks.clerk.user = null;
      render();
    }),
  };
  mocks.signIn = {
    status: 'complete', createdSessionId: 'session_device',
    ticket: vi.fn(async () => { events.push('ticket'); return {}; }),
    finalize: vi.fn(async () => { events.push('finalize'); return {}; }),
  };
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (input.endsWith('/device/status')) return Response.json({ present, clerkUserId: present ? owner : null });
    if (input.endsWith('/device/renew')) { events.push('renew'); return Response.json({ ticket, clerkUserId: owner }, { status: renewStatus }); }
    if (input.endsWith('/device/enroll')) { events.push('enroll'); present = true; return Response.json({ ok: true }); }
    if (input.endsWith('/device/revoke')) { events.push('revoke'); present = false; return Response.json({ ok: true }); }
    if (body?.clearSignInMarker) events.push('clear-marker');
    else if (body?.signedOut) events.push('mark-signed-out');
    else if (input.endsWith('/entitlement/sync')) events.push('license-sync');
    return Response.json({ ok: true, plan: 'free' });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetConsumedDesktopAuthTicketsForTest();
});

describe('mounted native Clerk bridge', () => {
  it('renews at initial load and clears the marker before license sync', async () => {
    await mount();
    expect(events.slice(0, 6)).toEqual(['renew', 'ticket', 'finalize', 'activate', 'clear-marker', 'license-sync']);
    expect(authState.signedIn).toBe(true);
    expect(events.filter((event) => event === 'renew')).toHaveLength(1);
  });

  it('enrolls a signed-in user once across focus bursts', async () => {
    present = false;
    mocks.signedIn = true;
    mocks.user = { id: owner, reload: async () => {} };
    mocks.clerk.user = mocks.user;
    await mount();
    await focus();
    await focus();
    expect(events.filter((event) => event === 'enroll')).toHaveLength(1);
  });

  it('renews after a non-explicit signed-in to signed-out flip', async () => {
    mocks.signedIn = true;
    mocks.user = { id: owner, reload: async () => {} };
    mocks.clerk.user = mocks.user;
    await mount();
    mocks.signedIn = false;
    mocks.user = null;
    mocks.clerk.user = null;
    await act(async () => { render(); });
    expect(events.filter((event) => event === 'renew')).toHaveLength(1);
    expect(authState.signedIn).toBe(true);
  });

  it('debounces focus and waits five minutes after a transient failure', async () => {
    renewStatus = 503;
    await mount();
    await focus();
    expect(events.filter((event) => event === 'renew')).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    renewStatus = 200;
    await focus();
    expect(events.filter((event) => event === 'renew')).toHaveLength(2);
    expect(authState.signedIn).toBe(true);
  });

  it('revokes before ending the session and never renews after explicit sign-out', async () => {
    await mount();
    events = [];
    await act(async () => { await authState.signOut(); });
    expect(events.indexOf('revoke')).toBeLessThan(events.indexOf('end-session'));
    expect(mocks.purge).toHaveBeenCalledTimes(2);
    await focus();
    expect(events).not.toContain('renew');
    expect(authState.signedIn).toBe(false);
  });

  it('waits for an in-flight ticket before completing explicit sign-out', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    mocks.signIn.ticket = vi.fn(async () => { events.push('ticket'); await hold; return {}; });
    await mount();
    let signingOut!: Promise<void>;
    await act(async () => { signingOut = authState.signOut(); });
    expect(events).toContain('revoke');
    expect(events).not.toContain('end-session');
    await act(async () => { release(); await signingOut; });
    expect(events.indexOf('activate')).toBeLessThan(events.indexOf('end-session'));
    expect(events).not.toContain('clear-marker');
    await focus();
    expect(authState.signedIn).toBe(false);
    expect(events.filter((event) => event === 'renew')).toHaveLength(1);
  });

  it('leaves web mode without device enrollment, renewal, or revoke', async () => {
    await mount(false);
    await focus();
    await act(async () => { await authState.signOut(); });
    expect(fetchMock.mock.calls.map(([url]) => url).filter((url) => url.includes('/device/'))).toEqual([]);
  });

  it('defers browser ticket enrollment and license sync until marker completion', async () => {
    present = false;
    await mount();
    // Import the same module instance as the mounted bridge after resetModules.
    const { consumeDesktopAuthCallback: consume } = await import('@/lib/auth/desktop-auth-callback');
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let callback!: Promise<void>;
    await act(async () => {
      callback = consume(`o8://auth/callback?ticket=${randomBytes(24).toString('hex')}&state=nonce`, {
        signIn: mocks.signIn as unknown as Parameters<typeof consumeDesktopAuthCallback>[1]['signIn'],
        clerk: mocks.clerk as unknown as Parameters<typeof consumeDesktopAuthCallback>[1]['clerk'],
        getExpectedState: () => 'nonce', clearExpectedState: () => {},
        onSignInComplete: async () => { await hold; events.push('clear-marker'); },
      });
    });
    expect(events).not.toContain('enroll');
    expect(events).not.toContain('license-sync');
    await act(async () => { release(); await callback; });
    expect(events).toContain('enroll');
    expect(events.indexOf('clear-marker')).toBeLessThan(events.indexOf('license-sync'));
  });

  it('enrolls after browser sign-in supersedes an initial status request', async () => {
    present = false;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementationOnce(async () => { await hold; return Response.json({ present: false, clerkUserId: null }); });
    await mount();
    const { consumeDesktopAuthCallback: consume } = await import('@/lib/auth/desktop-auth-callback');
    await act(async () => {
      await consume(`o8://auth/callback?ticket=${randomBytes(24).toString('hex')}&state=nonce`, {
        signIn: mocks.signIn as unknown as Parameters<typeof consumeDesktopAuthCallback>[1]['signIn'],
        clerk: mocks.clerk as unknown as Parameters<typeof consumeDesktopAuthCallback>[1]['clerk'],
        getExpectedState: () => 'nonce', clearExpectedState: () => {},
        onSignInComplete: async () => { events.push('clear-marker'); },
      });
    });
    fetchMock.mockImplementation(normalFetch);
    await act(async () => { release(); });
    expect(events.filter((event) => event === 'enroll')).toHaveLength(1);
  });

  it('allows the revoked device owner to enroll again after mismatch sign-out', async () => {
    present = false;
    mocks.signedIn = true;
    mocks.user = { id: owner, reload: async () => {} };
    mocks.clerk.user = mocks.user;
    await mount();
    mocks.clerk.setActive = vi.fn(async () => {
      mocks.signedIn = true;
      mocks.user = { id: 'user_other', reload: async () => {} };
      mocks.clerk.user = mocks.user;
      render();
    });
    mocks.signedIn = false;
    mocks.user = null;
    mocks.clerk.user = null;
    await act(async () => { render(); });
    expect(events).toContain('revoke');
    expect(authState.signedIn).toBe(false);
    await act(async () => {
      authState.signIn();
      mocks.signedIn = true;
      mocks.user = { id: owner, reload: async () => {} };
      mocks.clerk.user = mocks.user;
      render();
    });
    expect(events.filter((event) => event === 'enroll')).toHaveLength(2);
  });
});
