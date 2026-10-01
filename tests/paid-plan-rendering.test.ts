// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountTab from '@/app/voice-settings/tabs/AccountTab';
import { EntitlementProvider, useEntitlement } from '@/lib/entitlement/context';
import type { Plan } from '@/lib/entitlement/types';

// Icons are decorative; keep the real Account tab and its button primitives.
vi.mock('@/app/voice-settings/icons', () => ({
  ICONS: { user: () => null, gear: () => null },
  Icon: () => null,
}));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '0.0.0') }));
vi.mock('@/components/auth/O8AuthProvider', () => ({
  useO8Auth: () => ({ clerkEnabled: false, isLoaded: true, signedIn: false, user: null }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
    json: async () => ({ plan, actualPlan, overrideActive: actualPlan !== plan }),
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

    expect(container.textContent).toContain(plan.charAt(0).toUpperCase() + plan.slice(1));
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
