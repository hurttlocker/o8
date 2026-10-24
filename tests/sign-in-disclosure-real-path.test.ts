// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { O8AuthState } from '@/components/auth/O8AuthProvider';

const fixture = vi.hoisted(() => ({ auth: {} as O8AuthState, open: vi.fn() }));
vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => fixture.auth }));
vi.mock('@/lib/desktop/open-external', () => ({ openExternalUrl: fixture.open }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true }));

import { AccountTab } from '@/components/desktop/settings/AccountTab';
import { DesktopSignInDialog } from '@/components/auth/DesktopSignInDialog';
import { O8_AUTH_CALLBACK, O8_AUTH_STATE_KEY, O8_SIGN_IN_URL, startDesktopSignIn } from '@/lib/auth/start-desktop-sign-in';
import { clearDesktopAuthError } from '@/lib/auth/desktop-auth-error';

const disclosure = 'Sign-in shares your account profile and email. GitHub repository access is a separate connection.';
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, state: 'fixture-state' })));
  fixture.open.mockClear();
  fixture.auth = {
    clerkEnabled: true, isLoaded: true, signedIn: false, user: null,
    signIn: () => { void startDesktopSignIn(); },
    openManageAccount: vi.fn(), signOut: vi.fn(async () => {}),
  };
  clearDesktopAuthError();
  sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(label: string) {
  const found = [...document.querySelectorAll('button')].find(node => node.textContent === label);
  expect(found, label).toBeDefined();
  return found!;
}

describe('existing o8 account sign-in entry points', () => {
  it.each(['Settings account row', 'browser handoff'] as const)('discloses account sharing immediately under the %s button before sign-in', async surface => {
    await act(async () => root.render(surface === 'Settings account row'
      ? createElement(AccountTab)
      : createElement(DesktopSignInDialog, { onClose: vi.fn() })));
    const signIn = button(surface === 'Settings account row' ? 'Sign in to o8' : 'Continue in browser');
    expect(signIn.nextElementSibling?.textContent).toBe(disclosure);
    expect(document.getElementById(signIn.getAttribute('aria-describedby') ?? '')).toBe(signIn.nextElementSibling);
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.open).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(surface === 'Settings account row' ? 'Sign-in is optional.' : 'Signing in is optional.');
    expect(document.body.textContent).not.toMatch(/paid plan|managed allowance|reach this computer from your phone|open this computer from any browser/i);
    await act(async () => signIn.click());
    expect(fixture.open).toHaveBeenCalledOnce();
    const url = new URL(fixture.open.mock.calls[0][0]);
    expect(`${url.origin}${url.pathname}`).toBe(O8_SIGN_IN_URL);
    expect([...url.searchParams.entries()]).toEqual([
      ['state', 'fixture-state'], ['redirect_uri', O8_AUTH_CALLBACK],
    ]);
    expect(sessionStorage.getItem(O8_AUTH_STATE_KEY)).toBe('fixture-state');
  });

  it.each(['signed in', 'account-less'] as const)('does not ask a %s workspace to sign in', async state => {
    fixture.auth = state === 'signed in'
      ? { ...fixture.auth, signedIn: true, user: { id: 'fixture-account', name: 'Example profile', email: 'example@example.test', avatarUrl: null } }
      : { ...fixture.auth, clerkEnabled: false, localWorkspaceOnly: true };
    await act(async () => root.render(createElement(AccountTab)));
    expect(container.textContent).not.toContain('Sign in to o8');
    expect(container.textContent).not.toContain(disclosure);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lets the existing handoff close without starting sign-in', async () => {
    const close = vi.fn();
    await act(async () => root.render(createElement(DesktopSignInDialog, { onClose: close })));
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close sign-in"]')!.click());
    expect(close).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.open).not.toHaveBeenCalled();
  });
});
