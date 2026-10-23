// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { O8AuthState } from '@/components/auth/O8AuthProvider';

const mocks = vi.hoisted(() => ({ auth: {} as O8AuthState, founder: { operatorNumber: 37 } }));
vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => mocks.auth }));
vi.mock('@/lib/entitlement/context', () => ({ useEntitlement: () => ({ founder: mocks.founder }) }));
vi.mock('@/lib/auth/desktop-auth-error', () => ({
  getDesktopAuthError: () => null,
  clearDesktopAuthError: vi.fn(),
  subscribeDesktopAuthError: () => () => {},
}));

import { AccountTab } from './AccountTab';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.auth = {
    clerkEnabled: true, isLoaded: false, signedIn: false, user: null,
    signIn: vi.fn(), openManageAccount: vi.fn(), signOut: vi.fn(async () => {}),
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(createElement(AccountTab)));
}

it('settles an unresolved account read visibly and keeps native sign-in recovery reachable', async () => {
  await render();
  expect(container.textContent).toContain('Loading account');
  await act(async () => vi.advanceTimersByTimeAsync(8_000));
  expect(container.textContent).not.toContain('Loading account');
  expect(container.textContent).toContain('Account unavailable');
  const signIn = [...container.querySelectorAll('button')].find(button => button.textContent === 'Sign in to o8')!;
  expect(signIn.disabled).toBe(false);
  await act(async () => signIn.click());
  expect(mocks.auth.signIn).toHaveBeenCalledOnce();
  expect(mocks.auth.signOut).not.toHaveBeenCalled();
  expect(mocks.auth.isLoaded).toBe(false);
});

it('hides unresolved profile details and cached founder metadata', async () => {
  mocks.auth.signedIn = true;
  mocks.auth.user = { id: 'earlier-account', name: 'Earlier profile', email: 'earlier@example.test', avatarUrl: null };
  await render();
  expect(container.textContent).not.toContain('Earlier profile');
  expect(container.textContent).not.toContain('earlier@example.test');
  expect(container.textContent).not.toContain('037');
  expect(container.textContent).not.toContain('Manage account');
  expect(container.textContent).not.toContain('Sign out');
});

it('recovers when a late read resolves and reopens without the old loading failure', async () => {
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(8_000));
  mocks.auth = { ...mocks.auth, isLoaded: true, signedIn: true, user: {
    id: 'current-account', name: 'Current profile', email: 'current@example.test', avatarUrl: null,
  } };
  await render();
  expect(container.textContent).toContain('Current profile');
  expect(container.textContent).not.toContain('Account unavailable');
  expect(container.textContent).not.toContain('Loading account');
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(container.textContent).toContain('Current profile');
  expect(container.textContent).not.toContain('Account unavailable');
});

it('keeps a resolved signed-out or local profile distinct from failed loading', async () => {
  mocks.auth.isLoaded = true;
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(container.textContent).toContain('Local desktop profile');
  expect(container.textContent).not.toContain('Account unavailable');
  expect(container.textContent).not.toContain('037');
});

it('shows a signed-in profile without an edition or founder badge', async () => {
  mocks.auth = { ...mocks.auth, isLoaded: true, signedIn: true, user: {
    id: 'current-account', name: 'Current profile', email: 'current@example.test', avatarUrl: null,
  } };
  await render();
  expect(container.textContent).toContain('Manage account');
  expect(container.textContent).not.toContain('037');
  expect(container.innerHTML).not.toMatch(/lifetime|free plan|upgrade|pricing/i);
});
