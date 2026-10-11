// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountTab from '@/app/voice-settings/tabs/AccountTab';
import { BillingTab } from '@/components/desktop/settings/BillingTab';
import { SettingsQuickDrawer } from '@/components/desktop/SettingsQuickDrawer';
import { AccountBlock } from '@/components/desktop/account-block/AccountBlock';
import { GeneralTab } from '@/components/desktop/settings/GeneralTab';
import { EntitlementProvider, useEntitlement } from '@/lib/entitlement/context';
import type { Plan } from '@/lib/entitlement/types';

// Icons are decorative; keep the real Account tab and its button primitives.
vi.mock('@/app/voice-settings/icons', () => ({
  ICONS: { user: () => null, gear: () => null },
  Icon: () => null,
}));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '0.0.0') }));
const authState = vi.hoisted(() => ({ signedIn: false }));
vi.mock('@/components/auth/O8AuthProvider', () => ({
  useO8Auth: () => ({
    clerkEnabled: false, isLoaded: true, signedIn: authState.signedIn,
    user: authState.signedIn ? { id: 'user_fixture', name: 'Account' } : null,
  }),
}));
vi.mock('@/lib/theme/context', () => ({
  useTheme: () => ({ paletteId: 'light', surface: {}, workspaceGlass: false }),
}));
vi.mock('@/components/desktop/dictation/SymonMachineControl', () => ({
  SymonMachineControl: () => null, SymonOrbStatusLine: () => null,
  useSymonOrbMinimized: () => true,
}));
vi.mock('@/components/desktop/settings/operator-defaults-client', () => ({
  fetchOperatorDefaults: async () => Response.json({ values: {}, envLocked: {} }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  authState.signedIn = false;
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

function respondWithPlan(plan: Plan, actualPlan: Plan = plan) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({
      plan, actualPlan, overrideActive: actualPlan !== plan,
      founder: plan === 'founder' ? { operatorNumber: 7, tier: null } : null,
    }),
  })));
}

function EntitlementConsumer() {
  const { plan, isPro, loading } = useEntitlement();
  return createElement('output', null, loading ? 'Loading' : `${plan}:${isPro ? 'paid' : 'free'}`);
}

describe('voice settings Account tab paid plan rendering', () => {
  it.each<Plan>(['founder', 'pro', 'team'])('shows no upgrade prompt for %s', async (plan) => {
    respondWithPlan(plan);
    await act(async () => root.render(createElement(AccountTab)));

    const label = plan === 'founder' ? 'Pro · Lifetime' : plan === 'pro' ? 'Pro' : 'Team';
    expect(container.textContent).toContain(label);
    expect(container.textContent).not.toMatch(/Founder|Founding Operator/);
    expect(Array.from(container.querySelectorAll('button')).map((button) => button.textContent))
      .not.toContain('Upgrade');
    expect(container.textContent).toContain('Active');
    expect(container.textContent).toContain('Pro features unlocked across o8.');
  });

  it('keeps the upgrade prompt for free accounts', async () => {
    respondWithPlan('free');
    await act(async () => root.render(createElement(AccountTab)));

    expect(container.textContent).toContain('Free');
    expect(Array.from(container.querySelectorAll('button')).map((button) => button.textContent))
      .toContain('Upgrade');
    expect(container.textContent).not.toContain('Pro features unlocked across o8.');
  });
});

describe('lifetime plan copy in desktop settings', () => {
  it.each([
    { name: 'the sidebar account row', element: createElement(AccountBlock) },
    { name: 'General settings', element: createElement(GeneralTab) },
  ])('labels the lifetime plan in $name', async ({ element }) => {
    authState.signedIn = true;
    respondWithPlan('founder');
    await act(async () => root.render(createElement(EntitlementProvider, null,
      element,
    )));

    expect(container.textContent).toContain('Pro · Lifetime');
    expect(container.textContent).not.toMatch(/founder|founding operator/i);
  });

  it.each<Plan>(['founder', 'pro'])('labels %s distinctly in Plan & Billing', async (plan) => {
    respondWithPlan(plan);
    await act(async () => root.render(
      createElement(EntitlementProvider, null, createElement(BillingTab)),
    ));

    const currentPlan = container.querySelector('[data-settings-section="Current plan"]')?.closest('section');
    expect(currentPlan?.textContent).toContain(plan === 'founder' ? 'Pro · Lifetime' : 'Pro');
    expect(container.textContent).not.toMatch(/founding|founder/i);
    if (plan === 'founder') expect(container.textContent).toContain('for life');
    else expect(currentPlan?.textContent).not.toContain('Pro · Lifetime');
  });

  it('keeps the lifetime serial and renames the quick-settings badge tooltip', async () => {
    respondWithPlan('founder');
    await act(async () => root.render(createElement(EntitlementProvider, null,
      createElement(SettingsQuickDrawer, {
        open: true, anchorRect: null, onClose: () => {}, onOpenSettings: () => {},
      }),
    )));

    const drawer = document.querySelector('[aria-label="Quick settings"]');
    expect(drawer?.querySelector('[title="Pro · Lifetime · No. 007"]')?.textContent).toBe('007');
    expect(drawer?.innerHTML).not.toMatch(/Founding Operator/);
  });
});

describe('entitlement provider paid status through a mounted consumer', () => {
  it.each<Plan>(['founder', 'pro', 'team', 'free'])('exposes paid status for %s', async (plan) => {
    respondWithPlan(plan);
    await act(async () => root.render(
      createElement(EntitlementProvider, null, createElement(EntitlementConsumer)),
    ));

    expect(container.textContent).toBe(`${plan}:${plan === 'free' ? 'free' : 'paid'}`);
  });

  it('uses the effective free plan when the actual plan is founder', async () => {
    respondWithPlan('free', 'founder');
    await act(async () => root.render(
      createElement(EntitlementProvider, null, createElement(EntitlementConsumer)),
    ));

    expect(container.textContent).toBe('free:free');
  });
});
