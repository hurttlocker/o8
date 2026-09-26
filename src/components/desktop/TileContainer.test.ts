// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { insertBalancedTerminalTile, createDefaultTileLayout } from '@/lib/tiles/operations';
import type { TileContentRegistry } from './TileContainer';
import { TileContainer } from './TileContainer';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const terminal = { kind: 'terminal' as const, createdFromSplit: true, initialTab: 'terminal' as const };
const terminalDefinition = { description: 'Shell', label: 'Terminal', hideHeader: true, render: ({ tileId }: { tileId: string }) => createElement('div', null, tileId) };
const registry: TileContentRegistry = {
  terminal: terminalDefinition,
  workspace: terminalDefinition,
  preview: terminalDefinition,
  canvas: terminalDefinition,
  'contextual-panel': terminalDefinition,
};

describe('multiple terminal panes', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
  });

  it('keeps each shell identifiable and targets an exact edge drop and resize', async () => {
    const initial = createDefaultTileLayout();
    const second = insertBalancedTerminalTile(initial.root, 'tile-root', 'vertical', terminal);
    const third = insertBalancedTerminalTile(second.root, second.newTileId!, 'vertical', terminal);
    const onSplitTile = vi.fn();
    const onCloseTile = vi.fn();
    const onResizeSplit = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => { root = createRoot(container); });
    await act(async () => root.render(createElement(TileContainer, {
      activeTileId: second.newTileId,
      paneLabels: new Map([['tile-root', 'Terminal 1'], [second.newTileId!, 'Orchestrator'], [third.newTileId!, 'Terminal 3']]),
      layout: { ...initial, root: third.root },
      registry,
      onActivateTile: vi.fn(),
      onCloseTile,
      onResizeSplit,
      onSplitTile,
    })));

    expect(Array.from(container.querySelectorAll('[data-tile-kind="terminal"]')).map((pane) => pane.textContent)).toEqual([
      expect.stringContaining('Pane 1· Terminal 1'),
      expect.stringContaining('Pane 2· Orchestrator'),
      expect.stringContaining('Pane 3· Terminal 3'),
    ]);
    expect(container.querySelectorAll('[role="separator"][aria-label="Resize terminal panes"]')).toHaveLength(2);

    expect(container.querySelector('button[aria-label^="Add pane"]')).toBeNull();
    expect(container.querySelectorAll('button[aria-label^="Close pane"]')).toHaveLength(3);

    const firstPane = container.querySelector<HTMLElement>('[data-tile-id="tile-root"]')!;
    vi.spyOn(firstPane, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 300, height: 300 } as DOMRect);
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperties(drop, {
      dataTransfer: { value: { getData: () => 'chat' } },
      clientX: { value: 12 },
      clientY: { value: 150 },
    });
    await act(async () => firstPane.dispatchEvent(drop));
    expect(onSplitTile).toHaveBeenCalledWith('tile-root', 'vertical', 'chat', true, true);

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Close pane 2"]')?.click());
    expect(onCloseTile).toHaveBeenCalledExactlyOnceWith(second.newTileId);

    await act(async () => container.querySelector<HTMLElement>('[role="separator"]')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    ));
    expect(onResizeSplit).toHaveBeenCalledWith(expect.any(String), expect.closeTo(1 / 3 + 0.05));
  });

  it('keeps each pane’s own sessions reachable after the top header becomes a count', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const initial = createDefaultTileLayout();
    const second = insertBalancedTerminalTile(initial.root, 'tile-root', 'vertical', terminal);
    const selections: Array<{ tabId: string; workspaceId: string }> = [];
    const onSelect = (event: Event) => selections.push((event as CustomEvent<{ tabId: string; workspaceId: string }>).detail);
    window.addEventListener('o8:request-select-tab', onSelect);
    try {
      container = document.createElement('div');
      document.body.appendChild(container);
      await act(async () => { root = createRoot(container); });
      await act(async () => root.render(createElement(TileContainer, {
        activeTileId: 'tile-root',
        paneSessions: new Map([['tile-root', {
          workspaceId: 'workspace-1',
          activeTabId: 'tab-1',
          finishedTabCount: 0,
          tabs: [
            { id: 'tab-1', label: 'Terminal 1', kind: 'terminal', runtime: null, packetStatus: null },
            { id: 'tab-2', label: 'Orchestrator', kind: 'orchestrator', runtime: null, packetStatus: null },
          ],
        }]]),
        layout: { ...initial, root: second.root },
        registry,
        onActivateTile: vi.fn(),
        onCloseTile: vi.fn(),
        onResizeSplit: vi.fn(),
        onSplitTile: vi.fn(),
      })));
      expect(container.querySelector('[role="tablist"][aria-label="Open sessions in pane 1"]')).not.toBeNull();
      expect(container.querySelectorAll('button[aria-label^="Close pane"]')).toHaveLength(2);
      await act(async () => container.querySelector<HTMLElement>('[data-o8-workspace-tab="tab-2"]')?.click());
      expect(selections).toEqual([{ tabId: 'tab-2', workspaceId: 'workspace-1' }]);
    } finally {
      window.removeEventListener('o8:request-select-tab', onSelect);
      vi.unstubAllGlobals();
    }
  });

  it('closes the selected fourth pane without relying on a top-header close action', async () => {
    const initial = createDefaultTileLayout();
    const second = insertBalancedTerminalTile(initial.root, 'tile-root', 'vertical', terminal);
    const third = insertBalancedTerminalTile(second.root, second.newTileId!, 'vertical', terminal);
    const fourth = insertBalancedTerminalTile(third.root, third.newTileId!, 'vertical', terminal);
    const onCloseTile = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => { root = createRoot(container); });
    await act(async () => root.render(createElement(TileContainer, {
      activeTileId: 'tile-root',
      layout: { ...initial, root: fourth.root },
      registry,
      onActivateTile: vi.fn(),
      onCloseTile,
      onResizeSplit: vi.fn(),
      onSplitTile: vi.fn(),
    })));
    expect(container.querySelectorAll('button[aria-label^="Close pane"]')).toHaveLength(4);
    expect([...container.querySelectorAll('button[aria-label^="Close pane"]')].every((button) => button.textContent?.trim() === 'Close')).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Close pane 4"]')?.click());
    expect(onCloseTile).toHaveBeenCalledExactlyOnceWith(fourth.newTileId);
  });
});
