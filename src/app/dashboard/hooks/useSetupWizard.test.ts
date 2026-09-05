// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadSetupDetection: vi.fn(),
}));

vi.mock('@/lib/setup/detection-cache', () => ({
  loadSetupDetection: mocks.loadSetupDetection,
}));

import { useSetupWizard } from './useSetupWizard';

function mountHook(onValue: (value: ReturnType<typeof useSetupWizard>) => void): {
  host: HTMLDivElement;
  root: Root;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  function Harness(): ReactElement {
    onValue(useSetupWizard());
    return createElement('div');
  }

  act(() => root.render(createElement(Harness)));
  return { host, root };
}

describe('setup wizard startup detection', () => {
  let mounted: { host: HTMLDivElement; root: Root } | null = null;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    mocks.loadSetupDetection.mockReset();
    mocks.loadSetupDetection.mockResolvedValue({ tools: [] });
  });

  afterEach(() => {
    if (mounted) act(() => mounted?.root.unmount());
    mounted = null;
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('does not run CLI detection for a completed install', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ setupComplete: true })));
    const current = { value: null as ReturnType<typeof useSetupWizard> | null };
    mounted = mountHook((value) => { current.value = value; });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.loadSetupDetection).not.toHaveBeenCalled();
    expect(current.value?.setupWizardOpen).toBe(false);
    expect(current.value?.setupCheckComplete).toBe(true);
  });

  it('opens onboarding and loads detection when setup is incomplete', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ setupComplete: false })));
    const current = { value: null as ReturnType<typeof useSetupWizard> | null };
    mounted = mountHook((value) => { current.value = value; });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.loadSetupDetection).toHaveBeenCalledTimes(1);
    expect(current.value?.setupWizardOpen).toBe(true);
    expect(current.value?.setupCheckComplete).toBe(true);
  });
});
