// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCanvasSnapshot, saveCanvasSnapshot } from './canvas-persistence';
import { useCanvasSnapshot } from './use-canvas-snapshot';

vi.mock('./canvas-persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./canvas-persistence')>();
  return {
    ...actual,
    loadCanvasSnapshot: vi.fn(),
    saveCanvasSnapshot: vi.fn(),
  };
});

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

const noop = vi.fn();

describe('useCanvasSnapshot', () => {
  let container: HTMLDivElement;
  let root: Root;

  function Probe() {
    useCanvasSnapshot({
      activeRepoPath: '/repo',
      dockOpen: true,
      termCards: [{
        id: 1, requestId: 'term-1', sessionName: 'session-1', exited: false, live: true, revealHold: false,
        x: 10.4, y: 20.6, w: 560, h: 300, z: 10, cwd: '/repo', cwdLabel: 'repo',
      }],
      fileCards: [],
      treeCards: [],
      imageCards: [{
        id: 2, x: 30.4, y: 40.6, w: 320, h: 180, z: 11, aspect: 16 / 9,
        items: [{ src: 'data:image/png;base64,AA==', name: 'reference.png' }],
      }],
      videoCards: [],
      browserCards: [],
      chatCards: [],
      diffCards: [],
      specCards: [{ id: 3, x: 50.4, y: 60.6, w: 600, h: 420, z: 12, repoPath: '/repo' }],
      markdownCards: [],
      brainCards: [],
      setActiveRepoPath: noop as never,
      setDockOpen: noop as never,
      setBrowserCards: noop as never,
      setSpecCards: noop as never,
      setBrainCards: noop as never,
      setImageCards: noop as never,
      setMarkdownCards: noop as never,
      setVideoCards: noop as never,
      nextIdRef: { current: 4 },
      zPeakRef: { current: 12 },
      canvasMedia: { createObjectURL: vi.fn(() => null) },
      getMedia: vi.fn(async () => null),
      checkAliveSessions: vi.fn(async () => new Set<string>()),
      spawnFileCard: noop,
      spawnFileTreeCard: noop,
      pickThread: vi.fn(async () => {}),
      spawnDiffCard: vi.fn(async () => {}),
      spawnWorktreeDiffCard: vi.fn(async () => {}),
      spawnTerminal: noop,
      reattachTerminal: noop,
    });
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(loadCanvasSnapshot).mockReturnValue(null);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('debounces the current geometry and force-flushes it before unload', () => {
    act(() => root.render(createElement(Probe)));
    act(() => vi.advanceTimersByTime(701));

    expect(saveCanvasSnapshot).toHaveBeenCalledTimes(1);
    expect(saveCanvasSnapshot).toHaveBeenLastCalledWith({
      v: 1,
      activeRepoPath: '/repo',
      dockOpen: true,
      term: [{ x: 10, y: 21, w: 560, h: 300, cwd: '/repo', cwdLabel: 'repo', sessionName: 'session-1' }],
      file: [],
      tree: [],
      image: [{ x: 30, y: 41, w: 320, h: 180, aspect: 16 / 9, items: [{ src: 'data:image/png;base64,AA==', name: 'reference.png' }] }],
      video: [],
      browser: [],
      chat: [],
      diff: [],
      spec: [{ x: 50, y: 61, w: 600, h: 420, repoPath: '/repo' }],
      markdown: [],
      brain: [],
    });

    act(() => window.dispatchEvent(new Event('beforeunload')));
    expect(saveCanvasSnapshot).toHaveBeenCalledTimes(2);
  });
});
