// @vitest-environment jsdom

import { act, createElement, StrictMode, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  providers: [] as Array<{ Clerk?: unknown }>,
  engine: {},
  nativeInit: vi.fn(async () => ({})),
  clerk: { session: null, openSignIn: vi.fn(), openUserProfile: vi.fn() },
  userState: { isLoaded: false, isSignedIn: false, user: null as Record<string, unknown> | null },
  userListeners: new Set<() => void>(),
}));
vi.mock('@clerk/nextjs', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    ClerkProvider: ({ children, ...props }: { children: unknown; Clerk?: unknown }) => {
      mocks.providers.push(props);
      return children;
    },
    useUser: () => useSyncExternalStore(listener => {
      mocks.userListeners.add(listener);
      return () => { mocks.userListeners.delete(listener); };
    }, () => mocks.userState),
    useClerk: () => ({ ...mocks.clerk }),
    useSignIn: () => ({ signIn: null }),
  };
});
vi.mock('tauri-plugin-clerk', () => ({
  initClerk: mocks.nativeInit,
  noopLogger: () => ({}),
}));
vi.mock('@/components/auth/DesktopAuthCallbackHandler', () => ({ DesktopAuthCallbackHandler: () => null }));
vi.mock('@/lib/tauri/bridge', () => ({ canUseTauriEvents: () => false }));
vi.mock('@/lib/entitlement/context', () => ({ useEntitlement: () => ({ founder: null }) }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('location', new URL('http://localhost:3000/dashboard'));
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_live_fixture');
  mocks.providers.length = 0;
  mocks.nativeInit.mockReset().mockResolvedValue(mocks.engine);
  mocks.userState = { isLoaded: false, isSignedIn: false, user: null };
  mocks.userListeners.clear();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function mount(strict = false) {
  const { O8AuthProvider, useO8Auth } = await import('./O8AuthProvider');
  const { AccountTab } = await import('@/components/desktop/settings/AccountTab');
  function Workspace() {
    const auth = useO8Auth();
    return createElement('main', null,
      createElement('p', null, 'Workspace available'),
      createElement('output', { 'data-enabled': String(auth.clerkEnabled) }, auth.isLoaded ? 'resolved' : 'pending'));
  }
  const app = createElement(O8AuthProvider, null, createElement(Workspace), createElement(AccountTab));
  await act(async () => root.render(strict ? createElement(StrictMode, null, app) : app));
  await settleAccountModule();
}

async function settleAccountModule() {
  await act(async () => { await vi.dynamicImportSettled(); });
}

it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])(
  'keeps the workspace available without mounting a production browser account client on %s', async origin => {
    vi.stubGlobal('location', new URL(origin));
    await mount();
    expect(container.textContent).toContain('Workspace available');
    expect(mocks.providers).toHaveLength(0);
    expect(container.querySelector('output')?.getAttribute('data-enabled')).toBe('false');
    expect(mocks.nativeInit).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Use the desktop app or a development account configuration');
    expect(container.querySelector('button')?.textContent).not.toBe('Sign in to o8');
  },
);

it('keeps the native account engine on the same loopback origin', async () => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  await mount();
  expect(mocks.nativeInit).toHaveBeenCalledOnce();
  expect(mocks.providers.at(-1)?.Clerk).toBe(mocks.engine);
  expect(container.querySelector('output')?.getAttribute('data-enabled')).toBe('true');
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Sign in to o8')).toBe(true);
});

it('retains a development browser account configuration on loopback', async () => {
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test_fixture');
  await mount();
  expect(mocks.providers.length).toBeGreaterThan(0);
  expect(mocks.providers.at(-1)?.Clerk).toBeUndefined();
});

it.each(['https://app.example.test', 'http://localhost.example.test', 'http://192.0.2.1'])(
  'does not replace account authentication with local mode on %s', async origin => {
    vi.stubGlobal('location', new URL(origin));
    await mount();
    expect(mocks.providers.length).toBeGreaterThan(0);
    expect(container.querySelector('output')?.getAttribute('data-enabled')).toBe('true');
  },
);

it('does not apply the development exception to a production web build', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  await mount();
  expect(mocks.providers.length).toBeGreaterThan(0);
});

it('retains account-less startup when no account client is configured', async () => {
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', '');
  await mount();
  expect(mocks.providers).toHaveLength(0);
  expect(container.querySelector('output')?.textContent).toBe('resolved');
});

it('bounds a pending native initialization without signing out and coalesces retry observation', async () => {
  vi.useFakeTimers();
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  let resolve!: (value: object) => void;
  mocks.nativeInit.mockReturnValue(new Promise(value => { resolve = value; }));
  await mount(true);
  expect(container.querySelector('output')?.textContent).toBe('pending');
  expect(mocks.nativeInit).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTimeAsync(8000));
  expect(container.textContent).toContain('Account unavailable');
  expect(container.querySelector('output')?.textContent).toBe('pending');
  const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry account connection')!;
  await act(async () => retry.click());
  expect(container.textContent).toContain('Connecting account');
  expect(container.textContent).not.toContain('Account unavailable');
  expect(mocks.nativeInit).toHaveBeenCalledOnce();
  await act(async () => resolve(mocks.engine));
  await settleAccountModule();
  expect(mocks.providers.at(-1)?.Clerk).toBe(mocks.engine);
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Sign in to o8')).toBe(true);
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('retries a failed native initialization without falling back to browser cookies', async () => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  mocks.nativeInit.mockRejectedValueOnce(new Error('unavailable'));
  await mount();
  expect(container.textContent).toContain('Account unavailable');
  expect(mocks.providers).toHaveLength(0);
  const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry account connection')!;
  await act(async () => retry.click());
  await settleAccountModule();
  expect(mocks.nativeInit).toHaveBeenCalledTimes(2);
  expect(mocks.providers.at(-1)?.Clerk).toBe(mocks.engine);
  expect(container.textContent).not.toContain('Account unavailable');
});

it('keeps ordinary API traffic on the original fetch after recovering native initialization', async () => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  const nativeFetch = vi.mocked(globalThis.fetch);
  const pluginFetch = vi.fn(async () => Response.json({ ok: true }));
  mocks.nativeInit.mockImplementationOnce(async () => {
    // The native plugin patches fetch before awaiting its initialization.
    globalThis.fetch = pluginFetch;
    throw new Error('unavailable');
  });
  await mount();
  const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry account connection')!;
  await act(async () => retry.click());
  await settleAccountModule();
  await globalThis.fetch('/api/panel/status');
  expect(nativeFetch).toHaveBeenCalledWith('/api/panel/status', undefined);
  expect(pluginFetch).not.toHaveBeenCalled();
  await globalThis.fetch('https://clerk.o8.run/v1/client');
  expect(pluginFetch).toHaveBeenCalledWith('https://clerk.o8.run/v1/client', undefined);
});

it.each(['pending', 'rejected'] as const)(
  'preserves a workspace draft and Account view when %s native initialization recovers', async initial => {
    vi.useFakeTimers();
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    let resolve!: (value: object) => void;
    const pending = new Promise<object>(settle => { resolve = settle; });
    if (initial === 'rejected') mocks.nativeInit.mockRejectedValueOnce(new Error('unavailable'));
    mocks.nativeInit.mockReturnValue(pending);
    const { O8AuthProvider } = await import('./O8AuthProvider');
    const { AccountTab } = await import('@/components/desktop/settings/AccountTab');
    let mounts = 0;
    function Workspace() {
      const [draft, setDraft] = useState('');
      const [accountOpen, setAccountOpen] = useState(false);
      useEffect(() => { mounts += 1; }, []);
      return createElement('main', null,
        createElement('textarea', {
          'aria-label': 'Unsent workspace draft', value: draft,
          onChange: (event: { currentTarget: HTMLTextAreaElement }) => setDraft(event.currentTarget.value),
        }),
        createElement('button', { onClick: () => setAccountOpen(true) }, 'Open Account'),
        accountOpen ? createElement(AccountTab) : null);
    }
    await act(async () => root.render(createElement(StrictMode, null,
      createElement(O8AuthProvider, null, createElement(Workspace)))));
    const textarea = container.querySelector('textarea')!;
    const draft = 'Account recovery — keep this draft unsent.';
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, draft);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      container.querySelector('button')!.click();
    });
    if (initial === 'pending') await act(async () => vi.advanceTimersByTimeAsync(8000));
    expect(container.textContent).toContain('Account unavailable');
    const mountBaseline = mounts;
    if (initial === 'rejected') {
      const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry account connection')!;
      await act(async () => retry.click());
    }
    await act(async () => resolve(mocks.engine));
    await settleAccountModule();
    expect(mocks.nativeInit).toHaveBeenCalledTimes(initial === 'pending' ? 1 : 2);
    expect(container.querySelector('textarea')).toBe(textarea);
    expect(textarea.value).toBe(draft);
    expect(mounts).toBe(mountBaseline);
    expect(container.textContent).toContain('Your o8 profile and sign-in.');
    expect(container.textContent).not.toContain('Account unavailable');
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  },
);

it('publishes signed-in and signed-out state without remounting the workspace or repeating sync work', async () => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  mocks.userState = { isLoaded: true, isSignedIn: false, user: null };
  const { O8AuthProvider, useO8Auth } = await import('./O8AuthProvider');
  let mounts = 0;
  function Workspace() {
    const auth = useO8Auth();
    useEffect(() => { mounts += 1; }, []);
    return createElement('output', null, auth.signedIn ? auth.user?.name : 'Signed out');
  }
  const render = async () => {
    await act(async () => root.render(createElement(O8AuthProvider, null, createElement(Workspace))));
    await settleAccountModule();
  };
  await render();
  const output = container.querySelector('output');
  const baseline = mounts;
  expect(output?.textContent).toBe('Signed out');
  mocks.userState = {
    isLoaded: true, isSignedIn: true,
    user: { id: 'user_fixture', fullName: 'Fixture account', emailAddresses: [], imageUrl: null },
  };
  await act(async () => { mocks.userListeners.forEach(listener => listener()); });
  expect(output?.textContent).toBe('Fixture account');
  const callsAfterSignIn = vi.mocked(fetch).mock.calls.length;
  await render();
  expect(vi.mocked(fetch).mock.calls).toHaveLength(callsAfterSignIn);
  mocks.userState = {
    isLoaded: true, isSignedIn: true,
    user: { id: 'user_second_fixture', fullName: 'Second fixture account', emailAddresses: [], imageUrl: null },
  };
  await act(async () => { mocks.userListeners.forEach(listener => listener()); });
  expect(output?.textContent).toBe('Second fixture account');
  mocks.userState = { isLoaded: true, isSignedIn: false, user: null };
  await act(async () => { mocks.userListeners.forEach(listener => listener()); });
  expect(output?.textContent).toBe('Signed out');
  expect(container.querySelector('output')).toBe(output);
  expect(mounts).toBe(baseline);
  expect(vi.mocked(fetch).mock.calls.some(([url]) => /device\/revoke|handoff/.test(String(url)))).toBe(false);
});
