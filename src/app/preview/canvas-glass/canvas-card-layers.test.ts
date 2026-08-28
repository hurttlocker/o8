// @vitest-environment jsdom

import { act, createElement, Fragment, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasCardLayers } from './canvas-card-layers';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => createElement(Fragment, null, children),
}));
vi.mock('./terminal-card', () => ({
  TerminalGlassCard: ({ card }: { card: { id: number } }) => createElement('div', { 'data-kind': 'term', 'data-card-id': card.id }),
}));
vi.mock('./file-card', () => ({
  FileGlassCard: ({ card }: { card: { id: number } }) => createElement('div', { 'data-kind': 'file', 'data-card-id': card.id }),
}));
vi.mock('./file-tree-card', () => ({
  FileTreeCardLayer: ({ cards }: { cards: Array<{ id: number }> }) => createElement(
    Fragment,
    null,
    ...cards.map((card) => createElement('div', { key: card.id, 'data-kind': 'tree', 'data-card-id': card.id })),
  ),
}));
vi.mock('./image-card', () => ({
  ImageGlassCard: ({ card }: { card: { id: number } }) => createElement('div', { 'data-kind': 'image', 'data-card-id': card.id }),
}));
vi.mock('./video-card', () => ({
  VideoGlassCard: ({ card }: { card: { id: number } }) => createElement('div', { 'data-kind': 'video', 'data-card-id': card.id }),
}));
vi.mock('./browser-card', () => ({
  BrowserGlassCard: ({ card }: { card: { id: number } }) => createElement('div', { 'data-kind': 'browser', 'data-card-id': card.id }),
}));
vi.mock('./diff-card', () => ({
  DiffGlassCard: ({ card }: { card: { id: number } }) => createElement('div', { 'data-kind': 'diff', 'data-card-id': card.id }),
}));
vi.mock('./agent-card', () => ({
  AgentGlassCard: ({ card }: { card: { id: number } }) => createElement('div', { 'data-kind': 'agent', 'data-card-id': card.id }),
}));
vi.mock('./brain-card', () => ({
  BrainGlassCard: ({ card }: { card: { id: number } }) => createElement('div', { 'data-kind': 'brain', 'data-card-id': card.id }),
}));
vi.mock('./markdown-card', () => ({
  MarkdownGlassCard: ({ card }: { card: { id: number } }) => createElement('div', { 'data-kind': 'markdown', 'data-card-id': card.id }),
}));
vi.mock('./chat-card', () => ({
  ChatGlassCard: ({ card }: { card: { id: number } }) => createElement('div', { 'data-kind': 'chat', 'data-card-id': card.id }),
}));
vi.mock('./spec-card', () => ({
  SpecGlassCard: ({ card }: { card: { id: number } }) => createElement('div', { 'data-kind': 'spec', 'data-card-id': card.id }),
}));

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

const noop = vi.fn();

describe('CanvasCardLayers', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders one card per kind in the existing layer and key order', () => {
    act(() => root.render(createElement(CanvasCardLayers, {
      canvasZoomLevel: 1,
      pan: { x: 0, y: 0 },
      termCards: [{ id: 1 } as never],
      fileCards: [{ id: 2 } as never],
      treeCards: [{ id: 3 } as never],
      imageCards: [{ id: 4 } as never],
      videoCards: [{ id: 5 } as never],
      browserCards: [{ id: 6 } as never],
      diffCards: [{ id: 7 } as never],
      agentCards: [{ id: 8, laneId: 'lane-8' } as never],
      brainCards: [{ id: 9 } as never],
      markdownCards: [{ id: 10 } as never],
      chatCards: [{ id: 11, threadId: 'thread-11' } as never],
      specCards: [{ id: 12 } as never],
      activeLanes: [{ id: 'lane-8' }],
      convos: {},
      dropTargetId: null,
      specScreenMap: { zoom: 1, panX: 0, panY: 0 },
      terminal: { termVeil: 0.35, connectionEpoch: 1, onMove: noop, onResize: noop, onFocus: noop, onClose: noop, onTermVeilChange: noop, registerHandle: noop, sendTerminalAttach: noop, sendTerminalInput: noop, sendTerminalResize: noop, sendTerminalDetach: noop } as never,
      file: { termVeil: 0.35, onMove: noop, onResize: noop, onFocus: noop, onClose: noop } as never,
      tree: { spawnFileCard: noop, onMove: noop, onResize: noop, onFocus: noop, onClose: noop } as never,
      image: { onMove: noop, onResize: noop, onFocus: noop, onDrop: noop, cycleImageCard: noop, onSpread: noop, onClose: noop } as never,
      video: { onMove: noop, onResize: noop, onFocus: noop, onClose: noop, onPoster: noop } as never,
      browser: { onMove: noop, onResize: noop, onFocus: noop, onTabsChange: noop, onClose: noop } as never,
      diff: { onMove: noop, onResize: noop, onFocus: noop, onClose: noop, onRequestChanges: noop, onRefresh: noop } as never,
      agent: { onMove: noop, onResize: noop, onFocus: noop, onClose: noop, onReview: noop, onToggleExpand: noop } as never,
      brain: { onMove: noop, onResize: noop, onFocus: noop, onClose: noop } as never,
      markdown: { onMove: noop, onResize: noop, onFocus: noop, onClose: noop } as never,
      chat: { sendDefaults: {}, onLiveEvent: noop, onUserSend: noop, onTruncate: noop, onMove: noop, onResize: noop, onFocus: noop, onDock: noop, onClose: noop } as never,
      spec: { onMove: noop, onResize: noop, onFocus: noop, onClose: noop } as never,
    })));

    const rendered = Array.from(container.querySelectorAll<HTMLElement>('[data-kind]'));
    expect(rendered.map((node) => node.dataset.kind)).toEqual([
      'term', 'file', 'tree', 'image', 'video', 'browser', 'diff', 'agent', 'brain', 'markdown', 'chat', 'spec',
    ]);
    expect(rendered.map((node) => Number(node.dataset.cardId))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});
