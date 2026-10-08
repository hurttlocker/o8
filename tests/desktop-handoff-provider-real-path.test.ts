// @vitest-environment jsdom
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { O8AuthState } from '@/components/auth/O8AuthProvider';

const mocks = vi.hoisted(() => ({
  signedIn: false,
  user: null as { id: string; reload: () => Promise<void> } | null,
  clerk: {} as Record<string, unknown>,
  signIn: {} as Record<string, unknown>,
  opened: vi.fn(),
  ticket: vi.fn(async () => ({})),
  callbacks: null as ((event: { payload: string[] }) => void) | null,
}));
vi.mock('@clerk/nextjs', () => ({
  ClerkProvider: ({ children }: { children: unknown }) => children,
  useUser: () => ({ isLoaded: true, isSignedIn: mocks.signedIn, user: mocks.user }),
  useClerk: () => mocks.clerk,
  useSignIn: () => ({ signIn: mocks.signIn }),
}));
vi.mock('@clerk/nextjs/server', () => ({ auth: async () => ({ userId: null }) }));
vi.mock('tauri-plugin-clerk', () => ({ initClerk: async () => ({}), noopLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => [] }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, listener: typeof mocks.callbacks) => {
    if (name === 'o8:auth-callback') mocks.callbacks = listener;
    return () => { if (mocks.callbacks === listener) mocks.callbacks = null; };
  },
}));
vi.mock('@/lib/desktop/open-external', () => ({ openExternalUrl: mocks.opened }));
vi.mock('@/lib/auth/clerk-fetch-guard', () => ({ installTauriClerkFetchGuard: () => {} }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ paletteId: 'light', surface: 'solid' }) }));
vi.mock('@/lib/entitlement/context', () => ({ useEntitlement: () => ({ founder: null }) }));
vi.mock('@/lib/auth/tauri-clerk-store', async (original) => ({
  ...await original<typeof import('@/lib/auth/tauri-clerk-store')>(), purgeTauriClerkStore: async () => {},
}));

let dataDir: string;
let root: Root;
let state: O8AuthState;
let render: () => void;
let fetchMock: ReturnType<typeof vi.fn<(input: string, init?: RequestInit) => Promise<Response>>>;
let enrollments: number;

function localRequest(input: string, init?: RequestInit) {
  return new Request(`http://localhost${input}`, {
    ...init, headers: { host: 'localhost', 'x-o8-client-addr': '127.0.0.1', ...init?.headers },
  });
}

async function mount(withDrawer = false) {
  const { O8AuthProvider, useO8Auth } = await import('@/components/auth/O8AuthProvider');
  const Drawer = withDrawer ? (await import('@/components/desktop/SettingsQuickDrawer')).SettingsQuickDrawer : null;
  const Probe = () => {
    const value = useO8Auth();
    useEffect(() => { state = value; }, [value]);
    return null;
  };
  root = createRoot(document.createElement('div'));
  render = () => root.render(createElement(O8AuthProvider, null, createElement(Fragment, null,
    createElement(Probe), Drawer && createElement(Drawer, {
      open: true, anchorRect: null, onClose: () => {}, onOpenSettings: () => {},
    }),
  )));
  await act(async () => { render(); });
}

function callbackForLastHandoff() {
  const url = new URL(String(mocks.opened.mock.calls.at(-1)?.[0]));
  return `o8://auth/callback?state=${url.searchParams.get('state')}&ticket=${randomBytes(24).toString('hex')}`;
}

async function beginHandoff() {
  const opened = mocks.opened.mock.calls.length;
  await act(async () => {
    state.signIn();
    await vi.waitFor(() => expect(mocks.opened.mock.calls.length).toBe(opened + 1));
  });
  return callbackForLastHandoff();
}

async function deliver(raw: string) {
  await act(async () => {
    mocks.callbacks?.({ payload: [raw] });
    // The callback handler is intentionally event-driven and fire-and-forget.
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

beforeEach(() => {
  vi.resetModules();
  mocks.signedIn = false;
  mocks.user = null;
  mocks.opened.mockClear();
  mocks.ticket.mockClear();
  mocks.callbacks = null;
  enrollments = 0;
  sessionStorage.clear();
  dataDir = mkdtempSync(join(tmpdir(), 'o8-handoff-'));
  vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true, value: { metadata: { currentWindow: { label: 'main' } } },
  });
  mocks.signIn = { status: 'complete', createdSessionId: 'session_device', ticket: mocks.ticket, finalize: async () => ({}) };
  mocks.clerk = {
    user: null, session: { getToken: async () => randomBytes(24).toString('hex') },
    setActive: async () => {
      mocks.signedIn = true;
      mocks.user = { id: 'user_device', reload: async () => {} };
      mocks.clerk.user = mocks.user;
      render();
    },
    signOut: async () => {
      mocks.signedIn = false;
      mocks.user = null;
      mocks.clerk.user = null;
      render();
    },
  };
  fetchMock = vi.fn(async (input, init) => {
    if (input.includes('/auth/handoff')) {
      return (await import('@/app/api/panel/auth/handoff/route')).POST(localRequest(input, init));
    }
    if (input.endsWith('/device/revoke')) {
      return (await import('@/app/api/panel/auth/device/revoke/route')).POST(localRequest(input, init));
    }
    if (input.endsWith('/device/status')) return Response.json({ present: false, clerkUserId: null });
    if (input.endsWith('/device/enroll')) enrollments += 1;
    return Response.json({ ok: true, plan: 'free' });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('round 2 handoff through the native provider, real callback handler and persisted route state', () => {
  it('rejects a delayed callback from a handoff begun before explicit sign-out', async () => {
    await mount();
    const raw = await beginHandoff();
    await act(async () => { await state.signOut(); });
    await deliver(raw);
    expect(mocks.ticket.mock.calls.length).toBe(0);
    expect(state.signedIn).toBe(false);
    expect(enrollments).toBe(0);
    expect(mocks.opened.mock.calls.length).toBe(1);
  });

  it('rejects that older callback after a process restart and loss of sessionStorage', async () => {
    await mount();
    const raw = await beginHandoff();
    await act(async () => { await state.signOut(); root.unmount(); });
    vi.resetModules();
    sessionStorage.clear();
    await mount();
    await deliver(raw);
    expect(mocks.ticket.mock.calls.length).toBe(0);
    expect(state.signedIn).toBe(false);
  });

  it('accepts and consumes a new handoff begun after sign-out at mode 0600', async () => {
    await mount();
    await act(async () => { await state.signOut(); });
    const raw = await beginHandoff();
    const target = join(dataDir, 'desktop-auth-handoff.json');
    expect(existsSync(target)).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    await deliver(raw);
    expect(mocks.ticket.mock.calls.length).toBe(1);
    expect(state.signedIn).toBe(true);
    expect(enrollments).toBe(1);
    expect(existsSync(target)).toBe(false);
  });

  it('accepts the durable nonce despite stale sessionStorage and rejects the older local nonce', async () => {
    await mount();
    const raw = await beginHandoff();
    const older = randomBytes(24).toString('hex');
    sessionStorage.setItem('o8:auth-state', older);
    await deliver(raw);
    expect(mocks.ticket.mock.calls.length).toBe(1);
    expect(state.signedIn).toBe(true);
    expect(mocks.opened.mock.calls.length).toBe(1);
    await deliver(`o8://auth/callback?state=${older}&ticket=${randomBytes(24).toString('hex')}`);
    expect(mocks.ticket.mock.calls.length).toBe(1);
    expect(mocks.opened.mock.calls.length).toBe(1);
  });

  it('does not open a browser when an earlier begin response arrives after sign-out', async () => {
    await mount();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const response = await normal(input, init);
      if (input.endsWith('/handoff?action=begin')) await hold;
      return response;
    });
    await act(async () => { state.signIn(); });
    try {
      await act(async () => { await state.signOut(); });
    } finally {
      await act(async () => { release(); });
    }
    expect(mocks.opened.mock.calls.length).toBe(0);
    expect(state.signedIn).toBe(false);
  });

  it('ignores an earlier validation response that arrives after sign-out', async () => {
    await mount();
    const raw = await beginHandoff();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const response = await normal(input, init);
      if (input.endsWith('/handoff?action=validate')) await hold;
      return response;
    });
    await deliver(raw);
    try {
      await act(async () => { await state.signOut(); });
    } finally {
      await act(async () => { release(); });
    }
    expect(mocks.ticket.mock.calls.length).toBe(0);
    expect(state.signedIn).toBe(false);
    expect(enrollments).toBe(0);
  });

  it('does not report completed sign-out without durable handoff cancellation acknowledgement', async () => {
    mocks.signedIn = true;
    mocks.user = { id: 'user_device', reload: async () => {} };
    mocks.clerk.user = mocks.user;
    await mount();
    await beginHandoff();
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (input.endsWith('/device/revoke') || input.endsWith('/handoff?action=cancel')) throw new Error('Unavailable');
      return normal(input, init);
    });
    await act(async () => { await expect(state.signOut()).rejects.toThrow('Sign-out failed. Try again.'); });
    expect(state.signedIn).toBe(true);
  });

  it('shows the cancellation failure through the real Sign out button without an unhandled rejection', async () => {
    mocks.signedIn = true;
    mocks.user = { id: 'user_device', reload: async () => {} };
    mocks.clerk.user = mocks.user;
    await mount(true);
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (input.endsWith('/device/revoke') || input.endsWith('/handoff?action=cancel')) throw new Error('Unavailable');
      return normal(input, init);
    });
    const button = [...document.querySelectorAll('button')].find((element) => element.textContent?.trim() === 'Sign out');
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Sign-out could not be saved. Try again.');
    expect(state.signedIn).toBe(true);
  });

  it('keeps the Sign out button disabled and names a longer wait', async () => {
    mocks.signedIn = true;
    mocks.user = { id: 'user_device', reload: async () => {} };
    mocks.clerk.user = mocks.user;
    await mount(true);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (input.endsWith('/device/revoke')) await hold;
      return normal(input, init);
    });
    const button = [...document.querySelectorAll('button')].find((element) => element.textContent?.trim() === 'Sign out')!;
    vi.useFakeTimers();
    try {
      await act(async () => { button.click(); });
      expect(button.disabled).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(button.textContent).toContain('Waiting for sign-out');
    } finally {
      vi.useRealTimers();
      await act(async () => {
        release();
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    }
    expect(state.signedIn).toBe(false);
  });

  it('preserves browser-mode sign-in without a native handoff request', async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    await mount();
    await beginHandoff();
    expect(fetchMock.mock.calls.filter(([input]) => input.includes('/auth/handoff')).length).toBe(0);
  });
});
