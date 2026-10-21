// @vitest-environment jsdom

import { act, createElement, useLayoutEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectLeafNodes, createDefaultTileLayout, findTile, insertBalancedTerminalTile } from '@/lib/tiles/operations';
import type { TileLayout } from '@/lib/tiles/types';
import { useWorkspacePageLayouts } from './useWorkspacePageLayouts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('workspace page layouts', () => {
  let container: HTMLDivElement;
  let root: Root;
  let setTab: (id: string) => void;
  let setLayout: (layout: TileLayout) => void;
  let currentLayout: TileLayout;

  function Harness({ initialLayout, initialTab }: { initialLayout: TileLayout; initialTab: string }) {
    const [tab, updateTab] = useState(initialTab);
    const [layout, updateLayout] = useState(initialLayout);
    const [, updateActiveTile] = useState<string | null>('tile-root');
    useLayoutEffect(() => {
      setTab = updateTab;
      setLayout = updateLayout;
      currentLayout = layout;
    }, [layout]);
    useWorkspacePageLayouts({
      activeTabId: tab,
      hydrated: true,
      layout,
      setActiveTileId: updateActiveTile,
      setLayout: updateLayout,
    });
    return null;
  }

  beforeEach(async () => {
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => { root = createRoot(container); });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('restores each top tab’s own split tree while keeping the page switch separate from a pane split', async () => {
    const first = createDefaultTileLayout();
    const three = insertBalancedTerminalTile(first.root, 'tile-root', 'vertical', { kind: 'terminal' });
    const third = insertBalancedTerminalTile(three.root, three.newTileId!, 'vertical', { kind: 'terminal' });
    await act(async () => root.render(createElement(Harness, { initialLayout: { ...first, root: third.root }, initialTab: 'page-a' })));
    expect(collectLeafNodes(currentLayout.root)).toHaveLength(3);

    await act(async () => setTab('page-b'));
    expect(collectLeafNodes(currentLayout.root)).toHaveLength(1);
    const secondPageSplit = insertBalancedTerminalTile(currentLayout.root, 'tile-root', 'vertical', { kind: 'terminal' });
    await act(async () => setLayout({ ...currentLayout, root: secondPageSplit.root }));
    expect(collectLeafNodes(currentLayout.root)).toHaveLength(2);

    await act(async () => setTab('page-a'));
    expect(collectLeafNodes(currentLayout.root)).toHaveLength(3);
    await act(async () => setTab('page-b'));
    expect(collectLeafNodes(currentLayout.root)).toHaveLength(2);
  });

  it('keeps the primary repository on a new page so an attached terminal is not replaced by another repository’s restore', async () => {
    const first = createDefaultTileLayout();
    if (first.root.type !== 'leaf') throw new Error('Expected a primary pane');
    first.root.content = { kind: 'terminal', repoPath: '/repo/current' };
    const split = insertBalancedTerminalTile(first.root, 'tile-root', 'vertical', {
      kind: 'terminal', repoPath: '/repo/other',
    });
    await act(async () => root.render(createElement(Harness, {
      initialLayout: { ...first, root: split.root }, initialTab: 'existing-page',
    })));

    await act(async () => setTab('plugin-terminal-page'));
    expect(collectLeafNodes(currentLayout.root)).toHaveLength(1);
    expect(findTile(currentLayout.root, 'tile-root')).toMatchObject({
      content: { kind: 'terminal', repoPath: '/repo/current' },
    });

    await act(async () => setTab('existing-page'));
    expect(collectLeafNodes(currentLayout.root).map((leaf) => leaf.content)).toEqual([
      { kind: 'terminal', repoPath: '/repo/current' },
      { kind: 'terminal', repoPath: '/repo/other' },
    ]);
  });
});
