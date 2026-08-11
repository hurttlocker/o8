/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authState = {
  clerkEnabled: true,
  isLoaded: true,
  signedIn: false,
  user: null,
  signIn: vi.fn(),
  openManageAccount: vi.fn(),
  signOut: vi.fn(async () => {}),
};

vi.mock('@/components/auth/O8AuthProvider', () => ({
  useO8Auth: () => authState,
}));

import { EntitlementProvider, useEntitlement } from './context';

let container: HTMLDivElement;
let root: Root;

function Probe() {
  const entitlement = useEntitlement();
  return createElement('output', {
    'data-plan': entitlement.plan,
    'data-actual-plan': entitlement.actualPlan,
    'data-pro': String(entitlement.isPro),
    'data-team': String(entitlement.isTeam),
    'data-loading': String(entitlement.loading),
  });
}

describe('signed-out desktop cold boot', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal('fetch', vi.fn());
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('boots the complete Free product without account or hosted provisioning requests', async () => {
    await act(async () => {
      root.render(createElement(EntitlementProvider, null, createElement(Probe)));
    });

    const output = container.querySelector('output');
    expect(output?.dataset).toMatchObject({
      plan: 'free',
      actualPlan: 'free',
      pro: 'false',
      team: 'false',
      loading: 'false',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
