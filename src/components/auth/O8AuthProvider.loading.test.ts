// @vitest-environment jsdom
import { act, createElement, useEffect, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { O8AuthState } from './O8AuthProvider';

const imports = { sdk: 0, gate: null as Promise<void> | null };
beforeEach(() => {
  vi.resetModules();
  imports.sdk = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.doMock('@clerk/nextjs', async () => {
    imports.sdk++;
    if (imports.gate) await imports.gate;
    return {
      ClerkProvider: ({ children }: { children: unknown }) => children,
      useUser: () => ({ isLoaded: true, isSignedIn: false, user: null }),
      useClerk: () => ({ session: null }),
      useSignIn: () => ({ signIn: null }),
    };
  });
});
afterEach(() => {
  vi.doUnmock('@clerk/nextjs');
  vi.doUnmock('./ClerkAccountSession');
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('keeps configured account state pending and preserves the workspace while the SDK chunk loads', async () => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test_fixture');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));
  let release!: () => void;
  imports.gate = new Promise<void>(resolve => { release = resolve; });
  const host = document.createElement('div');
  const root = createRoot(host);
  let mounts = 0;
  try {
    const { O8AuthProvider, useO8Auth } = await import('./O8AuthProvider');
    function Workspace() {
      const auth = useO8Auth();
      const [draft, setDraft] = useState('');
      useEffect(() => { mounts++; }, []);
      return createElement('main', null,
        createElement('output', { 'data-configured': String(auth.clerkEnabled), 'data-connection': auth.accountConnection }, auth.isLoaded ? 'Ready' : 'Pending'),
        createElement('button', { onClick: () => setDraft('Kept draft') }, 'Edit draft'),
        createElement('button', { onClick: auth.retryAccountConnection }, 'Retry'),
        createElement('textarea', { value: draft, readOnly: true }));
    }
    await act(async () => root.render(createElement(O8AuthProvider, null, createElement(Workspace))));
    const workspace = host.querySelector('main');
    expect(host.querySelector('output')?.getAttribute('data-configured')).toBe('true');
    expect(host.querySelector('output')?.textContent).toBe('Pending');
    await act(async () => host.querySelector('button')!.click());
    await vi.waitFor(() => expect(imports.sdk).toBe(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(host.querySelector('output')?.getAttribute('data-connection')).toBe('unavailable');
    expect(host.querySelector('textarea')?.value).toBe('Kept draft');
    await act(async () => host.querySelectorAll('button')[1].click());
    expect(host.querySelector('output')?.getAttribute('data-connection')).toBe('initializing');
    expect(imports.sdk).toBe(1);
    release();
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(host.querySelector('main')).toBe(workspace);
    expect(host.querySelector('output')?.textContent).toBe('Ready');
    expect(host.querySelector('textarea')?.value).toBe('Kept draft');
    expect(mounts).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    release();
    await act(async () => root.unmount());
    imports.gate = null;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

it('contains a rejected SDK import and recovers without remounting or signing out the workspace', async () => {
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test_fixture');
  vi.doMock('./ClerkAccountSession', () => { throw new Error('fixture chunk unavailable'); });
  const host = document.createElement('div');
  const root = createRoot(host);
  let mounts = 0;
  try {
    const { O8AuthProvider, useO8Auth } = await import('./O8AuthProvider');
    function Workspace() {
      const auth = useO8Auth();
      useEffect(() => { mounts++; }, []);
      return createElement('main', null,
        createElement('output', null, auth.isLoaded ? 'Ready' : auth.accountConnection),
        createElement('button', { onClick: auth.retryAccountConnection }, 'Retry'),
        createElement('textarea', { defaultValue: 'Unsent draft' }));
    }
    await act(async () => root.render(createElement(O8AuthProvider, null, createElement(Workspace))));
    await act(async () => { await vi.dynamicImportSettled(); });
    const workspace = host.querySelector('main');
    expect(host.querySelector('output')?.textContent).toBe('unavailable');
    const ready: O8AuthState = { clerkEnabled: true, isLoaded: true, signedIn: false, user: null,
      signIn: () => {}, openManageAccount: () => {}, signOut: async () => {} };
    vi.doMock('./ClerkAccountSession', () => ({ ClerkAccountSession: function RecoveredSession({ onAuthChange }: {
      onAuthChange: (auth: O8AuthState) => void;
    }) {
      useLayoutEffect(() => { onAuthChange(ready); }, [onAuthChange]);
      return null;
    } }));
    // Model a fresh retryable chunk response while retaining the mounted root.
    vi.resetModules();
    await act(async () => host.querySelector('button')!.click());
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(host.querySelector('output')?.textContent).toBe('Ready');
    expect(host.querySelector('main')).toBe(workspace);
    expect(host.querySelector('textarea')?.value).toBe('Unsent draft');
    expect(mounts).toBe(1);
  } finally {
    await act(async () => root.unmount());
  }
});

it('boots the real account-less provider without importing the account SDK', async () => {
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', '');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    const { O8AuthProvider, useO8Auth } = await import('./O8AuthProvider');
    function Workspace() {
      const auth = useO8Auth();
      return createElement('output', null, auth.clerkEnabled ? 'Configured' : 'Account-less workspace');
    }
    await act(async () => root.render(createElement(O8AuthProvider, null, createElement(Workspace))));
    expect(host.textContent).toBe('Account-less workspace');
    expect(imports.sdk, 'unused account code must stay outside the document and hydration graph').toBe(0);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllEnvs();
  }
});
