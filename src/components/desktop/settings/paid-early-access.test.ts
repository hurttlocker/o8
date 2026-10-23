// @vitest-environment jsdom

import { act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plan } from '@/lib/entitlement/types';

vi.mock('@/components/auth/O8AuthProvider', () => ({
  useO8Auth: () => ({ clerkEnabled: false, isLoaded: true, signedIn: false, user: null }),
}));
vi.mock('@/lib/tauri/bridge', () => ({ storeSet: vi.fn(), isTauri: () => false }));
vi.mock('./SettingsTomlEditor', () => ({ SettingsTomlEditor: () => null }));
vi.mock('@/lib/desktop/open-external', () => ({ openExternalUrl: vi.fn() }));

import { openExternalUrl } from '@/lib/desktop/open-external';
import { GeneralTab } from './GeneralTab';
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
    root.render(createElement(Component));
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).not.toContain('Loading');
  });
}

describe('operator defaults early access', () => {
  it.each([
    ['free', true],
    ['pro', true],
    ['founder', true],
    ['team', true],
  ] as const)('shows experimental settings for %s: %s', async (plan, enabled) => {
    await mountSettings(OperatorDefaultsTab, plan);
    expect(container.textContent?.includes('Native browser-view')).toBe(enabled);
    expect(container.textContent?.includes('Canvas mode')).toBe(enabled);
  });

  it('keeps stability toggles visible without a license', async () => {
    await mountSettings(OperatorDefaultsTab, 'free');
    expect(container.textContent).toContain('Native browser-view');
    // Disabled stability defaults must not be silently turned on.
    expect(container.querySelectorAll('[role="switch"][aria-checked="false"]').length).toBeGreaterThan(0);
  });
});

describe('General settings free edition', () => {
  it.each(['free', 'pro', 'team', 'founder'] as const)('removes commerce from %s', async (plan) => {
    await mountSettings(GeneralTab, plan);
    expect(container.textContent).not.toMatch(/plan|upgrade|pricing|lifetime|subscription/i);
    expect(container.textContent).toContain('Privacy');
    expect(openExternalUrl).not.toHaveBeenCalled();
  });
});
