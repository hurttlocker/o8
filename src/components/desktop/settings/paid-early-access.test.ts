// @vitest-environment jsdom

import { act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plan } from '@/lib/entitlement/types';

vi.mock('@/components/auth/O8AuthProvider', () => ({
  useO8Auth: () => ({ clerkEnabled: false, isLoaded: true, signedIn: false, user: null }),
}));
vi.mock('@/lib/tauri/bridge', () => ({ storeSet: vi.fn() }));
vi.mock('./SettingsTomlEditor', () => ({ SettingsTomlEditor: () => null }));
vi.mock('@/lib/desktop/open-external', () => ({ openExternalUrl: vi.fn() }));

import { EntitlementProvider } from '@/lib/entitlement/context';
import { openExternalUrl } from '@/lib/desktop/open-external';
import { BillingTab } from './BillingTab';
import { OperatorDefaultsTab } from './OperatorDefaultsTab';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mountSettings(Component: ComponentType, plan: Plan, actualPlan: Plan = plan) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/panel/entitlement') return Response.json({ plan, actualPlan });
    if (url === '/api/panel/operator-defaults') {
      return Response.json({
        values: {
          parallelCap: 5,
          overlapGate: 'strict',
          requireApproval: 'always',
          updateAutoApply: 'off',
          workspaceManifestPolicy: 'disabled',
          experimentalCanvas: false,
          nativeBrowserView: false,
        },
        sources: {},
        effectiveOverride: { apfsDependencyImages: null },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  await act(async () => {
    root.render(createElement(EntitlementProvider, null, createElement(Component)));
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).not.toContain('Loading');
  });
}

describe('operator defaults early access', () => {
  it.each([
    ['free', false],
    ['pro', true],
    ['founder', true],
    ['team', true],
  ] as const)('shows experimental settings for %s: %s', async (plan, enabled) => {
    await mountSettings(OperatorDefaultsTab, plan);
    expect(container.textContent?.includes('Native browser-view')).toBe(enabled);
    expect(container.textContent?.includes('Canvas mode')).toBe(enabled);
  });

  it('uses the effective plan when previewing Free with a lifetime plan', async () => {
    await mountSettings(OperatorDefaultsTab, 'free', 'founder');
    expect(container.textContent).not.toContain('Native browser-view');
  });
});

describe('Plan & Billing subscription action', () => {
  it.each([
    ['free', 'Free', false],
    ['pro', 'Pro', true],
    ['founder', 'Pro · Lifetime', false],
    ['team', 'Team', false],
  ] as const)('renders the correct label and action for %s', async (plan, label, manageable) => {
    await mountSettings(BillingTab, plan);
    const currentPlan = container.querySelector('section');
    expect(currentPlan?.textContent).toContain(label);
    if (plan === 'pro') expect(currentPlan?.textContent).not.toContain('Lifetime');
    const button = [...container.querySelectorAll('button')]
      .find((entry) => entry.textContent === 'Manage subscription');
    expect(Boolean(button)).toBe(manageable);
    if (button) {
      await act(async () => button.click());
      expect(openExternalUrl).toHaveBeenCalledOnce();
      expect(openExternalUrl).toHaveBeenCalledWith('https://o8.run/account');
    } else {
      expect(openExternalUrl).not.toHaveBeenCalled();
    }
  });

  it('retains subscription management while previewing Free with a Pro plan', async () => {
    await mountSettings(BillingTab, 'free', 'pro');
    expect(container.textContent).toContain('Manage subscription');
  });

  it('retains lifetime identity while previewing Free with a lifetime plan', async () => {
    await mountSettings(BillingTab, 'free', 'founder');
    expect(container.querySelector('section')?.textContent).toContain('Pro · Lifetime');
    expect(container.textContent).not.toContain('Manage subscription');
  });
});
