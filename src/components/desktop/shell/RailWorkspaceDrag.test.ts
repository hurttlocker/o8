// @vitest-environment jsdom
import { act, createElement, Fragment, useLayoutEffect, useRef, useState, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompactNavigationRail } from './CompactNavigationRail';
import { TileContainer, type TileContentRegistry } from '../TileContainer';
import { useTileLayout, TILE_LAYOUT_STORAGE_KEY } from '@/app/dashboard/hooks/useTileLayout';
import { collectLeafNodes, computeTileLayout, createDefaultTileLayout, deserializeTileLayout, getFirstLeaf } from '@/lib/tiles/operations';
import { WORKSPACE_TAB_DRAG_TYPE } from '@/lib/tiles/workspace-tab-drag';
import type { TileLayout } from '@/lib/tiles/types';
import type { TerminalTabHandle } from '../workspace-terminal/types';
import type { ContextualPanelHandle } from '../ContextualPanel';

vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => ({ signedIn: false, user: null }) }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ paletteId: 'dark', workspaceGlass: true, surface: 'glass' }) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.0.0' }));
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: HTMLAttributes<HTMLDivElement>) => createElement('div', { style }, children) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
let latest: TileLayout;
const clickOrchestrator = vi.fn();
const clickTerminal = vi.fn();
const noop = () => {};
const surface = { label: 'Workspace', description: 'Session', hideHeader: true, render: () => createElement('iframe', { title: 'Interactive pane content' }) };
const registry: TileContentRegistry = { terminal: surface, workspace: surface, preview: surface, canvas: surface, 'contextual-panel': surface };

function Harness() {
  const [layout, setLayout] = useState(createDefaultTileLayout);
  const [activeTileId, setActiveTileId] = useState<string | null>('tile-root');
  useLayoutEffect(() => { latest = layout; }, [layout]);
  const controller = useTileLayout({
    tileLayout: layout, setTileLayout: setLayout, activeTileId, setActiveTileId,
    activeWorkspaceChatSessionKey: undefined, contextualPanelHandlesRef: useRef(new Map<string, ContextualPanelHandle>()),
    workspaceTerminalHandlesRef: useRef(new Map<string, TerminalTabHandle>()),
    findInsertionTarget: () => getFirstLeaf(layout.root), findWorkspaceTarget: () => null,
    globalRepoEntries: [], globalRepoEntry: null, refreshRestoredRepoState: async () => true,
    workspaceChatTargetKeyByRepoPath: {}, workspaceChatTargets: [], workspaceSidePanelRepoPath: null,
    workspaceTerminalPreferredRepo: null, waitForWorkspaceTerminalTarget: async () => { throw new Error('Not used by drag'); },
  });
  return createElement(Fragment, null,
    createElement(CompactNavigationRail, { activeDestination: 'agents', glassSurface: true,
      onHome: noop, onNewSession: clickOrchestrator, onCreateTerminal: clickTerminal, onOpenProjects: noop,
      onOpenSettings: noop, onOpenShortcuts: noop, onOpenPRs: noop, onOpenUsage: noop }),
    createElement(TileContainer, { keepPrimarySessionAlive: true, activeTileId, layout, registry,
      onActivateTile: setActiveTileId, onCloseTile: controller.handleCloseTile, onResizeSplit: controller.handleResizeSplit, onSplitTile: controller.handleSplitTile }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tools: [], repos: [], validatedRestorePaths: [] })));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

function transferEvent(type: string, transfer: object, x = 0, y = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { dataTransfer: { value: transfer }, clientX: { value: x }, clientY: { value: y } });
  return event;
}

const cases = (['orchestrator', 'terminal'] as const).flatMap(kind => [
  { kind, zone: 'left', x: 8, y: 150, direction: 'vertical', before: true },
  { kind, zone: 'right', x: 292, y: 150, direction: 'vertical', before: false },
  { kind, zone: 'above', x: 150, y: 8, direction: 'horizontal', before: true },
  { kind, zone: 'below', x: 150, y: 292, direction: 'horizontal', before: false },
  { kind, zone: 'center', x: 150, y: 150, direction: 'vertical', before: false },
]);

it.each(cases)('drags $kind from the rail into the real $zone split and preserves it on reload', async ({ kind, x, y, direction, before }) => {
  await act(async () => root.render(createElement(Harness)));
  const button = host.querySelector<HTMLButtonElement>(`[aria-label="Run ${kind}"]`)!;
  const data = new Map<string, string>();
  const transfer = { types: [] as string[], effectAllowed: '', dropEffect: '', setData(type: string, value: string) { data.set(type, value); this.types.push(type); }, getData: (type: string) => data.get(type) ?? '' };
  await act(async () => button.dispatchEvent(transferEvent('dragstart', transfer)));
  expect(transfer.effectAllowed).toBe('copy');
  expect(transfer.getData(WORKSPACE_TAB_DRAG_TYPE)).toBe(kind);
  const target = host.querySelector<HTMLElement>('[data-workspace-drop-target="tile-root"]')!;
  expect(target).not.toBeNull();
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 300, height: 300 } as DOMRect);
  await act(async () => target.dispatchEvent(transferEvent('dragover', transfer, x, y)));
  expect(host.textContent).toContain('Open');
  await act(async () => target.dispatchEvent(transferEvent('drop', transfer, x, y)));
  await act(async () => button.dispatchEvent(transferEvent('dragend', transfer)));
  expect(latest.root).toMatchObject({ type: 'split', direction, ratio: 0.5, userArranged: true });
  if (latest.root.type !== 'split') throw new Error('Expected a split');
  expect(latest.root.children[before ? 0 : 1]).toMatchObject({ type: 'leaf', content: { kind: 'terminal', initialTab: kind, createdFromSplit: true } });
  expect(latest.root.children[before ? 1 : 0]).toMatchObject({ type: 'leaf', id: 'tile-root' });
  const restored = deserializeTileLayout(window.localStorage.getItem(TILE_LAYOUT_STORAGE_KEY)!);
  expect(restored?.root).toEqual(latest.root);
  expect(host.querySelector('[data-workspace-drop-target]')).toBeNull();
  expect(clickOrchestrator).not.toHaveBeenCalled(); expect(clickTerminal).not.toHaveBeenCalled();
});

it('removes the iframe drop covers when a drag is cancelled and keeps both click entries working', async () => {
  await act(async () => root.render(createElement(Harness)));
  const button = host.querySelector<HTMLButtonElement>('[aria-label="Run orchestrator"]')!;
  const transfer = { types: [WORKSPACE_TAB_DRAG_TYPE], setData: noop, effectAllowed: '' };
  await act(async () => button.dispatchEvent(transferEvent('dragstart', transfer)));
  expect(host.querySelector('[data-workspace-drop-target]')).not.toBeNull();
  await act(async () => button.dispatchEvent(transferEvent('dragend', transfer)));
  expect(host.querySelector('[data-workspace-drop-target]')).toBeNull();
  expect(collectLeafNodes(latest.root)).toHaveLength(1);
  await act(async () => button.click());
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Run terminal"]')!.click());
  expect(clickOrchestrator).toHaveBeenCalledOnce(); expect(clickTerminal).toHaveBeenCalledOnce();
  expect(computeTileLayout(latest.root).leafRects.size).toBe(1);
});
