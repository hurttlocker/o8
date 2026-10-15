// @vitest-environment jsdom

import { act, createElement, Fragment, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompactNavigationRail } from './CompactNavigationRail';
import { TileContainer, type TileContentRegistry } from '../TileContainer';
import { createDefaultTileLayout } from '@/lib/tiles/operations';
import { getActiveWorkspacePaneDrag } from '@/lib/tiles/workspace-pane-drag';

vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => ({ isLoaded: true, signedIn: false, clerkEnabled: false }) }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ paletteId: 'dark', workspaceGlass: false }) }));
vi.mock('../analytics/use-runtime-usage', () => ({ useRuntimeUsage: () => ({ snapshot: null, loading: false, error: null }) }));
vi.mock('./RailUpdateControl', () => ({ RailUpdateControl: () => null }));
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: HTMLAttributes<HTMLDivElement>) => createElement('div', { style }, children) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function pointer(target: EventTarget, type: string, x: number, y: number, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: true } });
  target.dispatchEvent(event);
}

const definition = { description: 'Fixture', label: 'Fixture', hideHeader: true, render: () => createElement('iframe', { title: 'Embedded fixture' }) };
const registry: TileContentRegistry = { terminal: definition, workspace: definition, preview: definition, canvas: definition, 'contextual-panel': definition };

describe('rail to workspace pane dragging', () => {
  let host: HTMLDivElement;
  let root: Root;
  const onSplitTile = vi.fn();
  const onNewSession = vi.fn();
  const onCreateTerminal = vi.fn();
  const callbacks = { onNewSession, onCreateTerminal, onHome: vi.fn(), onOpenProjects: vi.fn(), onOpenSettings: vi.fn(), onOpenShortcuts: vi.fn(), onOpenPRs: vi.fn(), onOpenUsage: vi.fn() };
  const render = async (disabled = false) => {
    await act(async () => root.render(createElement(Fragment, null,
      createElement(CompactNavigationRail, { ...callbacks, activeDestination: 'agents', glassSurface: false }),
      createElement(TileContainer, { activeTileId: 'tile-root', layout: createDefaultTileLayout(), registry,
        keepPrimarySessionAlive: true, interactionDisabled: disabled,
        onActivateTile: vi.fn(), onCloseTile: vi.fn(), onResizeSplit: vi.fn(), onSplitTile }),
    )));
    vi.spyOn(host.querySelector<HTMLElement>('[data-tile-id="tile-root"]')!, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(100, 50, 500, 400));
  };
  const source = (label = 'Run terminal') => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove(); vi.restoreAllMocks();
    document.body.style.cursor = ''; document.body.style.userSelect = '';
  });

  it.each(['Run terminal', 'Run orchestrator'])('drops %s at the release edge exactly once and suppresses the drag click', async label => {
    await render();
    await act(async () => {
      pointer(source(label), 'pointerdown', 30, 100);
      pointer(document, 'pointermove', 400, 250);
    });
    expect(host.querySelector('[data-workspace-drop-target]')).not.toBeNull();
    expect(host.textContent).toContain('Open beside this pane');
    await act(async () => {
      // Release can reach another edge without a preceding move event there.
      pointer(document, 'pointerup', 110, 250);
      pointer(document, 'pointerup', 110, 250);
      source(label).dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(onSplitTile).toHaveBeenCalledExactlyOnceWith('tile-root', 'vertical', label === 'Run terminal' ? 'terminal' : 'orchestrator', true, true);
    expect(onNewSession).not.toHaveBeenCalled(); expect(onCreateTerminal).not.toHaveBeenCalled();
    expect(getActiveWorkspacePaneDrag()).toBeNull();
    expect(host.querySelector('[data-workspace-drop-target]')).toBeNull();
    await act(async () => source(label).click());
    expect(label === 'Run terminal' ? onCreateTerminal : onNewSession).toHaveBeenCalledOnce();
  });

  it('keeps clicks below threshold and keyboard activation, and accepts another drag after an outside drop', async () => {
    await render();
    await act(async () => {
      pointer(source(), 'pointerdown', 30, 100); pointer(document, 'pointermove', 32, 101); pointer(document, 'pointerup', 32, 101);
      source().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(onCreateTerminal).toHaveBeenCalledOnce(); expect(onSplitTile).not.toHaveBeenCalled();
    await act(async () => {
      pointer(source(), 'pointerdown', 30, 100); pointer(document, 'pointermove', 400, 200); pointer(document, 'pointerup', 900, 700);
      pointer(source(), 'pointerdown', 30, 100); pointer(document, 'pointermove', 400, 200); pointer(document, 'pointerup', 400, 440);
    });
    expect(onSplitTile).toHaveBeenCalledExactlyOnceWith('tile-root', 'horizontal', 'terminal', false, true);
  });

  it.each(['escape', 'cancel', 'blur', 'unmount'])('cancels on %s without starting a pane or leaving drag styles', async reason => {
    await render();
    document.body.style.cursor = 'crosshair'; document.body.style.userSelect = 'text';
    await act(async () => { pointer(source(), 'pointerdown', 30, 100); pointer(document, 'pointermove', 400, 200); });
    expect(document.body.style.cursor).toBe('grabbing');
    await act(async () => {
      if (reason === 'escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      else if (reason === 'cancel') pointer(document, 'pointercancel', 400, 200);
      else if (reason === 'blur') window.dispatchEvent(new Event('blur'));
      else root.render(null);
    });
    await act(async () => pointer(document, 'pointerup', 400, 200));
    expect(onSplitTile).not.toHaveBeenCalled(); expect(getActiveWorkspacePaneDrag()).toBeNull();
    expect(document.body.style.cursor).toBe('crosshair'); expect(document.body.style.userSelect).toBe('text');
    expect(host.querySelector('[data-workspace-drop-target]')).toBeNull();
  });

  it('ignores another pointer and a disabled workspace', async () => {
    await render(true);
    await act(async () => {
      pointer(source(), 'pointerdown', 30, 100); pointer(document, 'pointermove', 400, 200, 2); pointer(document, 'pointerup', 400, 200, 2);
    });
    expect(getActiveWorkspacePaneDrag()).toBeNull();
    await act(async () => { pointer(document, 'pointermove', 400, 200); pointer(document, 'pointerup', 400, 200); });
    expect(onSplitTile).not.toHaveBeenCalled();
  });
});
