// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerComposerCenter } from './composer-center-registry';
import { DesktopStatusBar } from './DesktopStatusBar';

vi.mock('@/lib/entitlement/context', () => ({
  useEntitlement: () => ({ overrideActive: false }),
}));
vi.mock('./dictation/SymonMachineControl', () => ({
  SymonOrbStatusLine: () => createElement('span', null, 'Symon status'),
}));
vi.mock('./merge-beacon/MergeBeacon', () => ({
  MergeBeacon: () => createElement('div', null, '1 escalated', createElement('button', null, 'Review merge')),
}));
vi.mock('./MergeActionCluster', () => ({
  MergeActionCluster: () => createElement('button', null, 'Merge PR'),
}));

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let unregisterComposer: (() => void) | null = null;

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  unregisterComposer?.();
  host?.remove();
  root = null;
  host = null;
  unregisterComposer = null;
  vi.unstubAllGlobals();
});

async function renderStatusBar() {
  await act(async () => {
    root?.render(createElement(DesktopStatusBar, {
      branchName: 'feature',
      repoName: 'project',
      onToggleBottomPanel: vi.fn(),
    }));
  });
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  });
}

describe('bottom chrome merge visibility', () => {
  it('keeps merge widgets out of the fallback footer', async () => {
    await renderStatusBar();
    expect(host?.textContent).not.toContain('escalated');
    expect(host?.textContent).not.toContain('Review merge');
    expect(host?.textContent).not.toContain('Merge PR');
    expect(host?.querySelector('[aria-label="Toggle bottom panel"]')).not.toBeNull();
  });

  it('keeps merge widgets out of the active composer row', async () => {
    const composer = document.createElement('div');
    composer.setAttribute('data-o8-composer-root', '');
    const center = document.createElement('div');
    center.setAttribute('data-composer-center', '');
    const slot = document.createElement('div');
    slot.setAttribute('data-o8-composer-status-slot', '');
    composer.append(center, slot);
    document.body.appendChild(composer);
    unregisterComposer = registerComposerCenter(center);

    try {
      await renderStatusBar();
      expect(slot.textContent).not.toContain('escalated');
      expect(slot.textContent).not.toContain('Review merge');
      expect(slot.textContent).not.toContain('Merge PR');
      expect(slot.querySelector('[aria-label="Toggle bottom panel"]')).not.toBeNull();
    } finally {
      composer.remove();
    }
  });
});
