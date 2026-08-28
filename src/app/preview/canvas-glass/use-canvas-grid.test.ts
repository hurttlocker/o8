// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANVAS_CARD_KINDS, type CanvasCardKind } from './canvas-commands';
import { useCanvasGrid } from './use-canvas-grid';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

const setterName = (kind: CanvasCardKind) => `set${kind === 'term' ? 'Term' : kind === 'tree' ? 'Tree' : kind[0]!.toUpperCase() + kind.slice(1)}Cards`;

describe('useCanvasGrid card dispatch', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('patches and dismisses each card kind through only its matching setter', () => {
    const setters = Object.fromEntries(CANVAS_CARD_KINDS.map((kind) => [setterName(kind), vi.fn()]));
    const cards = Object.fromEntries(CANVAS_CARD_KINDS.map((kind, index) => [
      `${kind}Cards`,
      [{ id: index + 1, x: index * 10, y: index * 10, z: 10 + index, w: 320, h: 240, items: [], src: '', mediaId: '' }],
    ]));
    const ids = Object.fromEntries(CANVAS_CARD_KINDS.map((kind, index) => [kind, index + 1])) as Record<CanvasCardKind, number>;
    const closeThrough = (kind: CanvasCardKind) => () => setters[setterName(kind)]!((previous: unknown) => previous);
    let hook: ReturnType<typeof useCanvasGrid> | null = null;

    function Probe() {
      const current = useCanvasGrid({
        ...cards,
        ...setters,
        canvasCardsRef: { current: Object.fromEntries(CANVAS_CARD_KINDS.map((kind) => [kind, cards[`${kind}Cards`]])) },
        gridMode: false,
        setGridMode: vi.fn(),
        winSize: { w: 1600, h: 900 },
        setWinSize: vi.fn(),
        pan: { x: 0, y: 0 },
        setPan: vi.fn(),
        panRef: { current: { x: 0, y: 0 } },
        canvasZoomLevel: 0.7,
        dockOpen: false,
        activeLanes: [],
        dockTrayExpanded: false,
        gridItemsRef: { current: [] },
        gridAnimRef: { current: null },
        setGridPlaceholder: vi.fn(),
        closeTerminal: closeThrough('term'),
        closeFileCard: closeThrough('file'),
        closeTreeCard: closeThrough('tree'),
        closeImageCard: closeThrough('image'),
        closeVideoCard: closeThrough('video'),
        closeBrowserCard: closeThrough('browser'),
        closeChatCard: closeThrough('chat'),
      } as never);
      useEffect(() => {
        hook = current;
      }, [current]);
      return null;
    }

    act(() => root.render(createElement(Probe)));

    for (const kind of CANVAS_CARD_KINDS) {
      vi.clearAllMocks();
      act(() => hook!.patchCanvasCardGeom(kind, ids[kind], { x: 88, y: 99 }));
      for (const candidate of CANVAS_CARD_KINDS) {
        expect(setters[setterName(candidate)], `patch ${kind} should route only to ${setterName(kind)}`).toHaveBeenCalledTimes(candidate === kind ? 1 : 0);
      }

      vi.clearAllMocks();
      act(() => hook!.dismissCanvasCard(kind, ids[kind]));
      for (const candidate of CANVAS_CARD_KINDS) {
        expect(setters[setterName(candidate)], `dismiss ${kind} should route only to ${setterName(kind)}`).toHaveBeenCalledTimes(candidate === kind ? 1 : 0);
      }
    }
  });
});
