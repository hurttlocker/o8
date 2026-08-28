// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { openExternalUrl } = vi.hoisted(() => ({ openExternalUrl: vi.fn() }));

vi.mock('@/lib/desktop/open-external', () => ({ openExternalUrl }));

import type { O8AuthState } from '@/components/auth/O8AuthProvider';
import { GitHubConnectionSections, type GitHubConnectionProps } from './GitHubTab';

const auth: O8AuthState = {
  clerkEnabled: true,
  isLoaded: true,
  signedIn: true,
  user: { id: 'user_1', name: 'Test', email: null, avatarUrl: null },
  signIn: vi.fn(),
  openManageAccount: vi.fn(),
  signOut: vi.fn(async () => {}),
};

function props(overrides: Partial<GitHubConnectionProps> = {}): GitHubConnectionProps {
  return {
    auth,
    managedAppEntitled: false,
    accounts: [],
    repoCount: 0,
    broker: {
      configured: false,
      appId: null,
      privateKeyConfigured: false,
      webhookSecretConfigured: false,
      publicBaseUrlConfigured: false,
      webhookUrl: null,
      productionWebhookReady: false,
      installationReachable: false,
      installationId: null,
      installationAccount: null,
      probeRepo: null,
      tokenReady: false,
      authSource: 'none',
      note: 'Not configured',
      managed: false,
      managedInstallUrl: null,
    },
    loading: false,
    ...overrides,
  };
}

describe('GitHub managed App entitlement', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    openExternalUrl.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows Upgrade and local setup to Free without exposing the managed action', () => {
    act(() => root.render(createElement(GitHubConnectionSections, props())));

    expect(container.textContent).toContain('included with Pro');
    expect(container.textContent).toContain('Upgrade');
    expect(container.textContent).toContain('Set up locally');
    expect(container.textContent).not.toContain('Use managed app');
    expect(container.textContent).not.toContain('Install');

    const localSetup = Array.from(container.querySelectorAll<HTMLAnchorElement>('a'))
      .find((link) => link.textContent === 'Set up locally');
    expect(localSetup?.href).toBe('https://github.com/settings/apps/new');
  });

  it('opens pricing from the Free upgrade action', () => {
    act(() => root.render(createElement(GitHubConnectionSections, props())));

    const upgrade = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Upgrade');
    act(() => upgrade?.click());

    expect(openExternalUrl).toHaveBeenCalledWith('https://o8.run/pricing');
  });

  it('opens only the server-provided install URL for a paid account', () => {
    const managedInstallUrl = 'https://github.com/apps/o8-run/installations/new';
    act(() => root.render(createElement(GitHubConnectionSections, props({
      managedAppEntitled: true,
      broker: {
        ...props().broker!,
        managedInstallUrl,
      },
    }))));

    expect(container.textContent).toContain('Install');
    expect(container.textContent).not.toContain('Upgrade');
    const install = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Install');
    act(() => install?.click());

    expect(openExternalUrl).toHaveBeenCalledWith(managedInstallUrl);
    expect(openExternalUrl).not.toHaveBeenCalledWith('https://github.com/settings/apps/new');
  });

  it('does not substitute the create-App URL when a paid install URL is absent', () => {
    act(() => root.render(createElement(GitHubConnectionSections, props({
      managedAppEntitled: true,
    }))));

    expect(container.textContent).not.toContain('Use managed app');
    expect(container.textContent).not.toContain('Install');
    expect(openExternalUrl).not.toHaveBeenCalled();
  });
});
