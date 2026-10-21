// @vitest-environment jsdom
import { act, createElement, forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextualPanel, type ContextualPanelHandle } from '@/components/desktop/ContextualPanel';
import { TileContainer, type TileContentRegistry } from '@/components/desktop/TileContainer';
import { createDefaultTileLayout, findLeafByContentKind, getFirstLeaf } from '@/lib/tiles/operations';
import { useTileLayout } from './useTileLayout';
import { createDashboardChromeKeydownHandler } from '../dashboard-chrome-shortcuts';

vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ surface: 'glass', themeId: 'dark-glass' }) }));
vi.mock('@/components/desktop/BottomXtermPanel', () => ({ BottomXtermPanel: forwardRef(function Terminal({ tmuxSession }: { tmuxSession: string }, ref) {
  const [text, setText] = useState('');
  useImperativeHandle(ref, () => ({ writeData: (data: string) => setText((old) => old + atob(data)), setExited: vi.fn(), setError: vi.fn(), showImage: vi.fn() }));
  return createElement('pre', { 'data-session': tmuxSession }, text);
}) }));
vi.mock('@/lib/operator/use-experimental-opencode', () => ({ useExperimentalOpencodeFlag: () => false }));
vi.mock('@/lib/operator/use-experimental-gemini', () => ({ useExperimentalGeminiFlag: () => false }));
vi.mock('@/components/desktop/contextual-panel/surfaces', async (importOriginal) => ({ ...await importOriginal<object>(), BottomUtilitySurface: () => null }));

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => { if (root) await act(async () => root?.unmount()); host?.remove(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('bottom terminal continuity through the dashboard layout', () => {
  it('keeps one shell, output, draft and resized split through three X and keyboard hide/show cycles', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const created: string[] = [];
    let currentLayout = createDefaultTileLayout();
    let resize: ((id: string, ratio: number) => void) | undefined;
    let handles: Map<string, ContextualPanelHandle> | undefined;
    function Harness() {
      const [layout, setLayout] = useState(createDefaultTileLayout);
      const [activeTileId, setActiveTileId] = useState<string | null>('tile-root');
      const contextualPanelHandlesRef = useRef(new Map<string, ContextualPanelHandle>());
      const workspaceTerminalHandlesRef = useRef(new Map());
      const controls = useTileLayout({ activeTileId, activeWorkspaceChatSessionKey: undefined, contextualPanelHandlesRef,
        findInsertionTarget: () => getFirstLeaf(layout.root), findWorkspaceTarget: () => null,
        globalRepoEntries: [], globalRepoEntry: null, refreshRestoredRepoState: async () => true,
        setActiveTileId, setTileLayout: setLayout, tileLayout: layout, workspaceChatTargetKeyByRepoPath: {}, workspaceChatTargets: [], workspaceSidePanelRepoPath: null,
        workspaceTerminalHandlesRef, workspaceTerminalPreferredRepo: null, waitForWorkspaceTerminalTarget: vi.fn(),
      });
      useEffect(() => {
        currentLayout = layout; resize = controls.handleResizeSplit; handles = contextualPanelHandlesRef.current;
      }, [layout, controls.handleResizeSplit]);
      useEffect(() => {
        const handler = createDashboardChromeKeydownHandler({ toggleSidebar: vi.fn(), openSettings: vi.fn(), toggleBottomPanel: controls.toggleContextualPanelTile, toggleRightPanel: vi.fn(), toggleTerminalMode: vi.fn(), spawnOrchestrator: vi.fn(), openCanvas: vi.fn() });
        window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
      }, [controls.toggleContextualPanelTile]);
      const noop = () => {};
      const terminal = { label: 'Workspace', description: '', render: () => createElement('textarea', { 'aria-label': 'Kept draft', defaultValue: 'unsent draft' }) };
      const registry = { workspace: terminal, terminal, canvas: terminal, preview: terminal,
        'contextual-panel': { label: 'Shell', description: '', hideHeader: true,
          render: ({ tileId, content }: { tileId: string; content: { kind: string; hidden?: boolean } }) => createElement(ContextualPanel, {
            ref: (handle: ContextualPanelHandle | null) => controls.registerContextualPanelHandle(tileId, handle),
            visible: !content.hidden, onHide: () => controls.handleCloseTile(tileId), onClose: () => controls.handleCloseTile(tileId),
            termWsConnected: true, sendTerminalCreate: (_cols: number, _rows: number, requestId?: string) => {
              const session = `owned-shell-${created.length + 1}`; created.push(session);
              queueMicrotask(() => handles?.get(tileId)?.onSessionCreated(session, requestId));
            }, sendTerminalAttach: noop, sendTerminalInput: noop, sendTerminalResize: noop, sendTerminalDetach: noop, sendAgentKill: noop,
          }),
        },
      } as TileContentRegistry;
      return createElement(TileContainer, { layout, registry, activeTileId, onActivateTile: setActiveTileId, onCloseTile: controls.handleCloseTile, onResizeSplit: controls.handleResizeSplit, onSplitTile: controls.handleSplitTile });
    }
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(createElement(Harness)));
    const toggle = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true }));
    await act(async () => toggle());
    const panelId = findLeafByContentKind(currentLayout.root, 'contextual-panel')!.id;
    await act(async () => handles!.get(panelId)!.writeToTerminal('owned-shell-1', btoa('KEPT-OUTPUT')));
    const output = host.querySelector('[data-session="owned-shell-1"]');
    expect(output?.textContent).toBe('KEPT-OUTPUT');
    expect(currentLayout.root.type).toBe('split');
    await act(async () => resize!(currentLayout.root.id, 0.52));
    for (let index = 0; index < 3; index += 1) {
      const hide = host.querySelector<HTMLButtonElement>('[aria-label="Hide bottom panel"]');
      expect(hide).not.toBeNull();
      await act(async () => hide!.click());
      expect(host.querySelector('[data-tile-kind="contextual-panel"]')?.getAttribute('aria-hidden')).toBe('true');
      await act(async () => toggle());
      expect(host.querySelector('[data-session="owned-shell-1"]')).toBe(output);
      expect(output?.textContent).toBe('KEPT-OUTPUT');
      expect(currentLayout.root).toMatchObject({ type: 'split', ratio: 0.52 });
    }
    expect(created).toEqual(['owned-shell-1']);
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Kept draft"]')?.value).toBe('unsent draft');
    await act(async () => { toggle(); });
    await act(async () => { toggle(); });
    expect(created).toEqual(['owned-shell-1']);
    expect(host.querySelector('[data-session="owned-shell-1"]')).toBe(output);
  });
});
