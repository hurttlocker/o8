// @vitest-environment jsdom

import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  providers: [] as Array<{ Clerk?: unknown }>,
  engine: {},
  nativeInit: vi.fn(async () => ({})),
  clerk: { session: null, openSignIn: vi.fn(), openUserProfile: vi.fn() },
}));
vi.mock('@clerk/nextjs', () => ({
  ClerkProvider: ({ children, ...props }: { children: unknown; Clerk?: unknown }) => {
    mocks.providers.push(props);
    return children;
  },
  useUser: () => ({ isLoaded: false, isSignedIn: false, user: null }),
  useClerk: () => mocks.clerk,
  useSignIn: () => ({ signIn: null }),
}));
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

