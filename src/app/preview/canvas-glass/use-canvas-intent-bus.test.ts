// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANVAS_CARD_KINDS } from './canvas-commands';
import { useCanvasIntentBus } from './use-canvas-intent-bus';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

type IntentWindow = Window & {
  __o8CanvasIntentLast?: { verb?: string; ok?: boolean; data?: { count?: number } };
  __o8CanvasIntentReady?: boolean;
};

describe('useCanvasIntentBus', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    delete (window as IntentWindow).__o8CanvasIntentLast;
    delete (window as IntentWindow).__o8CanvasIntentReady;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('routes spawn and list intents through the real canvas event path', () => {
    const spawnBrainCard = vi.fn();
    const canvasCards = Object.fromEntries(CANVAS_CARD_KINDS.map((kind) => [kind, []]));
    const deps = {
      activeRepoPath: '/repo',
      repos: [{ name: 'repo', path: '/repo' }],
      convos: {},
      canvasEnabled: true,
      canvasZoomLevel: 0.7,
      dockOpen: false,
      gridMode: false,
      pan: { x: 0, y: 0 },
      winSize: { w: 1600, h: 900 },
      nextIdRef: { current: 1 },
      composerInputRef: { current: null },
      canvasCardsRef: { current: canvasCards },
      imageCardsRef: { current: [] },
      zPeakRef: { current: 9 },
      spawnBrainCard,
      canvasViewport: vi.fn(() => ({ x: 0, y: 0, w: 1600, h: 900, zoom: 0.7 })),
      findCanvasCard: vi.fn(),
      readCanvasCard: vi.fn(),
      sendPrompt: vi.fn(),
      animatePanTo: vi.fn(),
      setImageCards: vi.fn(),
      setSearchOpen: vi.fn(),
      setSearchQuery: vi.fn(),
      setCanvasZoomLevel: vi.fn(),
      setDockOpen: vi.fn(),
      setGridMode: vi.fn(),
      setSessionsOpen: vi.fn(),
      openFilePicker: vi.fn(),
      showCanvasToast: vi.fn(),
      viewportSpawnOrigin: vi.fn(() => ({ x: 0, y: 0 })),
    };

    function Probe() {
      useCanvasIntentBus(deps as never);
      return null;
    }

    act(() => root.render(createElement(Probe)));
    expect((window as IntentWindow).__o8CanvasIntentReady).toBe(true);

    act(() => window.dispatchEvent(new CustomEvent('o8:canvas-intent', {
      detail: { verb: 'ask-brain', args: { question: 'Where is the seam?' } },
    })));
    expect(spawnBrainCard).toHaveBeenCalledWith('Where is the seam?');
    expect((window as IntentWindow).__o8CanvasIntentLast?.verb).toBe('ask-brain');

    act(() => window.dispatchEvent(new CustomEvent('o8:canvas-intent', {
      detail: { verb: 'list', args: {} },
    })));
    expect((window as IntentWindow).__o8CanvasIntentLast).toMatchObject({
      verb: 'list',
      ok: true,
      data: { count: 0 },
    });
    expect(spawnBrainCard).toHaveBeenCalledTimes(1);
  });
});
