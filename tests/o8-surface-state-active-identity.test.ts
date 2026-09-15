// @vitest-environment jsdom
//
// Regression for o8 issue #2307 — o8_view_surface_state must report the REAL
// active project/tab identity instead of null.
//
// Test boundary: mount the REAL WorkspaceTerminalRoot (the active-identity
// producer named in the issue) and run the REAL generated SURFACE_STATE_SCRIPT
// through the REAL o8_view_surface_state handler against the mounted DOM. Only
// the session-transport/state seams and the expensive child panels are
// substituted:
//   - the controller is controlled INPUT keyed by the real `stateScope` prop;
//   - the terminal-mode hook is a controlled seam that can return the effective
//     terminal tab;
//   - the panel seam renders a realistic minimal active composer, matching the
//     composer the live populated workspace shows (a panel-only substitution —
//     the surface-state producer/reader is never stubbed).
// jsdom reports zero-size rects, so the browser geometry model (element
// bounding boxes) is supplied explicitly; without it every element reads as
// invisible and the composer resolution short-circuits.
//
// The composer and geometry are fixture fidelity only. Active identity comes
// from production code, so no identity attribute is authored in this fixture.
//
// Expected behavior: SURFACE_STATE_SCRIPT always returns a successful
// structured state — carrying the active workspace's repo, tab id and tab kind
// when a workspace is mounted, and nulls when none is (empty/unmounted), never
// a stale or guessed value.

import { act, createElement, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredRepo, TerminalTab, WorkspaceTerminalProps } from '@/components/desktop/workspace-terminal/types';
import { createO8WebviewCompositeHandlers } from '@/lib/mcp/o8-webview-composites';
import type { O8WebviewClient } from '@/lib/mcp/o8-webview-client';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// ── Mocked seams ──────────────────────────────────────────────────────────
// The terminal controller owns the PTY session transport and heavy panels. It
// is swapped for controlled state keyed by the real `stateScope` prop so two
// split roots can hold distinct controllers. The panel seam renders the
// composer the populated workspace shows; it is off for the empty workspace.
const controllerHarness = vi.hoisted(() => ({
  byScope: new Map<string, unknown>(),
  fallback: null as unknown,
}));

const panelHarness = vi.hoisted(() => ({ composer: true }));

const terminalModeHarness = vi.hoisted(() => ({
  terminalTab: null as unknown,
  effectiveActiveTabId: null as string | null,
}));

vi.mock('@/components/desktop/workspace-terminal/useWorkspaceTerminalController', () => ({
  useWorkspaceTerminalController: (props: { stateScope?: string }) => (
    controllerHarness.byScope.get(props.stateScope ?? '') ?? controllerHarness.fallback
  ),
}));

vi.mock('@/components/desktop/workspace-terminal/use-terminal-mode', () => ({
  useTerminalMode: () => ({
    active: terminalModeHarness.terminalTab !== null,
    effectiveActiveTabId: terminalModeHarness.effectiveActiveTabId,
    terminalTab: terminalModeHarness.terminalTab,
    statusEvidence: null,
    toggle: () => undefined,
  }),
}));

vi.mock('@/components/desktop/workspace-terminal/use-outside-worker-split-mount', () => ({
  useOutsideWorkerSplitMount: () => undefined,
}));

vi.mock('@/components/desktop/workspace-terminal/WorkspaceTerminalPanels', async () => {
  const { createElement: h } = await import('react');
  return {
    WorkspaceTerminalPanels: () => (panelHarness.composer
      ? h('textarea', {
        'data-o8-active-composer': 'true',
        'aria-label': 'Message the active session',
        rows: 2,
        readOnly: true,
      })
      : null),
  };
});

vi.mock('@/components/desktop/workspace-terminal/PreviewPane', () => ({
  PreviewPane: () => null,
}));

import { WorkspaceTerminalRoot } from '@/components/desktop/workspace-terminal/WorkspaceTerminalRoot';

// ── Fixtures ──────────────────────────────────────────────────────────────
const O8_REPO: RegisteredRepo = { name: 'o8', localPath: '/repos/o8' };
const NOTES_REPO: RegisteredRepo = { name: 'notes-app', localPath: '/repos/notes-app' };

function tab(over: Partial<TerminalTab> & Pick<TerminalTab, 'id' | 'kind'>): TerminalTab {
  return {
    label: over.label ?? over.id,
    tmuxSession: null,
    createdAt: 0,
    lastActivity: 0,
    ...over,
  };
}

const ORCHESTRATOR_TAB = tab({ id: 'tab-alpha', kind: 'orchestrator', label: 'Fix surface state', repo: O8_REPO });
const SECOND_ORCHESTRATOR_TAB = tab({ id: 'tab-beta', kind: 'orchestrator', label: 'Second session', repo: O8_REPO });
const TERMINAL_TAB = tab({ id: 'tab-gamma', kind: 'terminal', label: 'notes-app / Shell', repo: NOTES_REPO });

function noop(): void {}

function makeController({
  activeTab,
  tabs,
  activeRepo,
  visibleTabs,
}: {
  activeTab: TerminalTab | null;
  tabs: TerminalTab[];
  activeRepo: RegisteredRepo | null;
  visibleTabs?: TerminalTab[];
}): Record<string, unknown> {
  const allTabs = visibleTabs ?? tabs;
  return {
    activeRepo,
    activeTab,
    attachWorkspaceTerminalSession: noop,
    cleanupFinishedTabs: () => ({ closedCount: 0, closedTabs: [] }),
    containerDivRef: { current: null } satisfies RefObject<HTMLDivElement | null>,
    effectiveActiveTabId: activeTab?.id ?? null,
    finishedTabCount: 0,
    handleClosePreview: noop,
    handleCloseTab: noop,
    handleConsumeChatDraftInjection: noop,
    handleDragStart: noop,
    handleNewLLMChatTab: noop,
    handleNewTab: noop,
    handleOpenWorkspaceCommitTab: noop,
    handleRestoreLatestCheckpoint: noop,
    handleRunCommandInTerminal: noop,
    handleSaveCheckpoint: noop,
    handleSelectTab: noop,
    handleUpdateChatMessages: noop,
    handleUpdateChatModel: noop,
    handleUpdateChatSessionKey: noop,
    handleUpdateLinkedIssue: noop,
    handleUpdateLlmSummary: noop,
    handleUpdateTabLabel: noop,
    handleUpdateTabMode: noop,
    isDragging: false,
    panelRefs: {} as never,
    previewHeight: 0.4,
    previews: [] as never[],
    primaryRestoreSettled: true,
    spawnChatTab: noop,
    spawnFleetCanvasTab: noop,
    spawnOrchestratorTab: noop,
    spawnSingleRuntimeTab: noop,
    tabs: allTabs,
    termWsConnected: true,
    undoCleanup: noop,
    visibleTabs: allTabs,
  };
}

function rootProps(stateScope: string, over: Partial<WorkspaceTerminalProps> = {}): WorkspaceTerminalProps {
  return {
    stateScope,
    defaultTab: 'llm-chat',
    sendTerminalCreate: noop,
    sendTerminalAttach: noop,
    sendTerminalInput: noop,
    sendTerminalResize: noop,
    sendTerminalVisibility: noop,
    sendTerminalDetach: noop,
    termWsConnected: true,
    ...over,
  };
}

// ── Real tool-path driver ─────────────────────────────────────────────────
// Execute the actual generated script in the jsdom global scope and feed the
// result back through the actual tool handler exactly as the webview client
// would.
function runScriptInPage(code: string): string {
  const fn = new Function(`return (${code});`) as () => string;
  return fn();
}

const evalClient = {
  evalJs: async (code: string) => ({ result: runScriptInPage(code) }),
} as unknown as O8WebviewClient;

interface PublicSurfaceState {
  route: string;
  activeWorkspaceRepo: string | null;
  activeTabKind: string | null;
  activeTabId: string | null;
  openDialogs: string[];
  composerFocused: boolean;
}

async function readSurfaceState(): Promise<PublicSurfaceState> {
  const handler = createO8WebviewCompositeHandlers(() => evalClient).o8_view_surface_state;
  const result = await handler({});
  const text = (result.content[0] as { text: string }).text;
  if (result.isError) {
    // A structured tool error is a reader failure, not an identity mismatch.
    throw new Error(`o8_view_surface_state returned a structured tool error (not an identity mismatch): ${text}`);
  }
  return JSON.parse(text) as PublicSurfaceState;
}

describe('o8_view_surface_state active identity (#2307)', () => {
  let container: HTMLDivElement;
  let root: Root;

  // jsdom has no layout engine: model element geometry so the script's
  // visibility gate resolves the mounted tree the way the browser does.
  const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  beforeAll(() => {
    Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: Element) {
        const width = this.tagName === 'TEXTAREA' ? 320 : 40;
        const height = this.tagName === 'TEXTAREA' ? 56 : 24;
        return {
          x: 0, y: 0, top: 0, left: 0, right: width, bottom: height,
          width, height, toJSON: () => ({}),
        } as DOMRect;
      },
    });
  });

  beforeEach(async () => {
    controllerHarness.byScope.clear();
    controllerHarness.fallback = null;
    panelHarness.composer = true;
    terminalModeHarness.terminalTab = null;
    terminalModeHarness.effectiveActiveTabId = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: originalGetBoundingClientRect,
    });
  });

  async function mount(props: WorkspaceTerminalProps) {
    await act(async () => {
      root.render(createElement(WorkspaceTerminalRoot, props));
    });
  }

  it('reports the populated project repo, active tab id and tab kind', async () => {
    controllerHarness.fallback = makeController({
      activeRepo: O8_REPO,
      activeTab: ORCHESTRATOR_TAB,
      tabs: [ORCHESTRATOR_TAB, SECOND_ORCHESTRATOR_TAB, TERMINAL_TAB],
    });
    await mount(rootProps('tile-primary', { activeWorkspaceSurface: true }));

    const state = await readSurfaceState();
    expect(state.activeWorkspaceRepo).toBe('o8');
    expect(state.activeTabId).toBe('tab-alpha');
    expect(state.activeTabKind).toBe('orchestrator');
  });

  it('updates the reported identity when the controller switches tab and repo', async () => {
    controllerHarness.fallback = makeController({
      activeRepo: O8_REPO,
      activeTab: ORCHESTRATOR_TAB,
      tabs: [ORCHESTRATOR_TAB, TERMINAL_TAB],
    });
    await mount(rootProps('tile-primary', { activeWorkspaceSurface: true }));
    expect((await readSurfaceState()).activeTabId).toBe('tab-alpha');

    controllerHarness.fallback = makeController({
      activeRepo: NOTES_REPO,
      activeTab: TERMINAL_TAB,
      tabs: [ORCHESTRATOR_TAB, TERMINAL_TAB],
    });
    await mount(rootProps('tile-primary', { activeWorkspaceSurface: true }));

    const switched = await readSurfaceState();
    expect(switched.activeWorkspaceRepo).toBe('notes-app');
    expect(switched.activeTabId).toBe('tab-gamma');
    expect(switched.activeTabKind).toBe('terminal');
  });

  it('returns a successful null identity for an empty or unmounted workspace', async () => {
    controllerHarness.fallback = makeController({
      activeRepo: O8_REPO,
      activeTab: ORCHESTRATOR_TAB,
      tabs: [ORCHESTRATOR_TAB],
    });
    await mount(rootProps('tile-primary', { activeWorkspaceSurface: true }));

    // Empty workspace: no active tab, no tabs, no composer surface. The reader
    // must still succeed and report nulls — never the previous identity, never
    // a crash on the absent composer.
    panelHarness.composer = false;
    controllerHarness.fallback = makeController({ activeRepo: null, activeTab: null, tabs: [] });
    await mount(rootProps('tile-primary', { activeWorkspaceSurface: true }));
    const empty = await readSurfaceState();
    expect(empty.activeTabId).toBeNull();
    expect(empty.activeTabKind).toBeNull();
    expect(empty.activeWorkspaceRepo).toBeNull();

    // Full unmount (workspace leaves / dashboard switches view).
    await act(async () => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
    });
    const unmounted = await readSurfaceState();
    expect(unmounted.activeTabId).toBeNull();
    expect(unmounted.activeTabKind).toBeNull();
    expect(unmounted.activeWorkspaceRepo).toBeNull();
  });

  it('reports the active split pane identity, never the inactive pane', async () => {
    const inactiveTab = tab({ id: 'worker-pane-tab', kind: 'orchestrator', label: 'Other repo work', repo: NOTES_REPO });
    const activeTab = tab({ id: 'focus-pane-tab', kind: 'terminal', label: 'o8 / Shell', repo: O8_REPO });
    controllerHarness.byScope.set('pane-left', makeController({
      activeRepo: NOTES_REPO,
      activeTab: inactiveTab,
      tabs: [inactiveTab],
    }));
    controllerHarness.byScope.set('pane-right', makeController({
      activeRepo: O8_REPO,
      activeTab,
      tabs: [activeTab],
    }));

    await act(async () => {
      root.render(createElement(
        'div',
        null,
        createElement(WorkspaceTerminalRoot, rootProps('pane-left', { activeWorkspaceSurface: false })),
        createElement(WorkspaceTerminalRoot, rootProps('pane-right', { activeWorkspaceSurface: true })),
      ));
    });

    const state = await readSurfaceState();
    expect(state.activeTabId).toBe('focus-pane-tab');
    expect(state.activeTabKind).toBe('terminal');
    expect(state.activeWorkspaceRepo).toBe('o8');
    expect(state.activeTabId).not.toBe('worker-pane-tab');
  });

  it('keeps the active identity fixed while extra worker tabs are running', async () => {
    const workerOne = tab({ id: 'worker-1', kind: 'orchestrator', label: 'Packet one', repo: O8_REPO });
    const workerTwo = tab({ id: 'worker-2', kind: 'orchestrator', label: 'Packet two', repo: O8_REPO });
    controllerHarness.fallback = makeController({
      activeRepo: O8_REPO,
      activeTab: ORCHESTRATOR_TAB,
      tabs: [ORCHESTRATOR_TAB, workerOne, workerTwo],
    });
    await mount(rootProps('tile-primary', { activeWorkspaceSurface: true }));

    const state = await readSurfaceState();
    expect(state.activeTabId).toBe('tab-alpha');
    expect(state.activeTabKind).toBe('orchestrator');
    expect(state.activeWorkspaceRepo).toBe('o8');
  });

  it('reports composer focus alongside the active identity', async () => {
    controllerHarness.fallback = makeController({
      activeRepo: O8_REPO,
      activeTab: ORCHESTRATOR_TAB,
      tabs: [ORCHESTRATOR_TAB, SECOND_ORCHESTRATOR_TAB],
    });
    await mount(rootProps('tile-primary', { activeWorkspaceSurface: true }));

    const composer = container.querySelector('textarea');
    expect(composer).not.toBeNull();
    await act(async () => {
      composer?.focus();
    });

    const state = await readSurfaceState();
    expect(state.composerFocused).toBe(true);
    expect(state.activeTabId).toBe('tab-alpha');
    expect(state.activeTabKind).toBe('orchestrator');
    expect(state.activeWorkspaceRepo).toBe('o8');
  });

  it('never reports a hidden or inactive workspace root', async () => {
    const hiddenTab = tab({ id: 'hidden-tab', kind: 'orchestrator', label: 'Hidden pane work', repo: NOTES_REPO });
    const activeTab = tab({ id: 'slot-tab', kind: 'terminal', label: 'o8 / Shell', repo: O8_REPO });
    controllerHarness.byScope.set('slot-active', makeController({ activeRepo: O8_REPO, activeTab, tabs: [activeTab] }));
    controllerHarness.byScope.set('slot-hidden', makeController({ activeRepo: NOTES_REPO, activeTab: hiddenTab, tabs: [hiddenTab] }));

    // Active pane first, then a hidden/inactive pane after it — DOM order must
    // not decide identity.
    await act(async () => {
      root.render(createElement(
        'div',
        null,
        createElement(WorkspaceTerminalRoot, rootProps('slot-active', { activeWorkspaceSurface: true })),
        createElement(
          'div',
          { style: { display: 'none' } },
          createElement(WorkspaceTerminalRoot, rootProps('slot-hidden', { activeWorkspaceSurface: false })),
        ),
      ));
    });

    const state = await readSurfaceState();
    expect(state.activeTabId).toBe('slot-tab');
    expect(state.activeTabKind).toBe('terminal');
    expect(state.activeWorkspaceRepo).toBe('o8');
    expect(state.activeTabId).not.toBe('hidden-tab');
  });

  it('does not report a lone workspace explicitly marked inactive', async () => {
    controllerHarness.fallback = makeController({ activeRepo: O8_REPO, activeTab: ORCHESTRATOR_TAB, tabs: [ORCHESTRATOR_TAB] });
    await mount(rootProps('inactive-only', { activeWorkspaceSurface: false }));
    const state = await readSurfaceState();
    expect(state.activeWorkspaceRepo).toBeNull();
    expect(state.activeTabId).toBeNull();
    expect(state.activeTabKind).toBeNull();
  });

  it('does not report identity from a workspace hidden by its ancestor', async () => {
    controllerHarness.fallback = makeController({ activeRepo: O8_REPO, activeTab: ORCHESTRATOR_TAB, tabs: [ORCHESTRATOR_TAB] });
    await act(async () => {
      root.render(createElement('div', { style: { display: 'none' } },
        createElement(WorkspaceTerminalRoot, rootProps('hidden-pane', { activeWorkspaceSurface: true }))));
    });
    const state = await readSurfaceState();
    expect(state.activeWorkspaceRepo).toBeNull();
    expect(state.activeTabId).toBeNull();
    expect(state.activeTabKind).toBeNull();
  });

  it('follows the active surface when two roots exchange the active marker', async () => {
    const leftTab = tab({ id: 'left-tab', kind: 'orchestrator', label: 'Left pane work', repo: NOTES_REPO });
    const rightTab = tab({ id: 'right-tab', kind: 'terminal', label: 'o8 / Shell', repo: O8_REPO });
    controllerHarness.byScope.set('swap-left', makeController({ activeRepo: NOTES_REPO, activeTab: leftTab, tabs: [leftTab] }));
    controllerHarness.byScope.set('swap-right', makeController({ activeRepo: O8_REPO, activeTab: rightTab, tabs: [rightTab] }));

    const renderSwap = async (activeScope: 'swap-left' | 'swap-right') => {
      await act(async () => {
        root.render(createElement(
          'div',
          null,
          createElement(WorkspaceTerminalRoot, rootProps('swap-left', { activeWorkspaceSurface: activeScope === 'swap-left' })),
          createElement(WorkspaceTerminalRoot, rootProps('swap-right', { activeWorkspaceSurface: activeScope === 'swap-right' })),
        ));
      });
    };

    await renderSwap('swap-left');
    const left = await readSurfaceState();
    expect(left.activeTabId).toBe('left-tab');
    expect(left.activeTabKind).toBe('orchestrator');
    expect(left.activeWorkspaceRepo).toBe('notes-app');

    await renderSwap('swap-right');
    const right = await readSurfaceState();
    expect(right.activeTabId).toBe('right-tab');
    expect(right.activeTabKind).toBe('terminal');
    expect(right.activeWorkspaceRepo).toBe('o8');
  });

  it('reports the effective terminal-mode tab as the active identity', async () => {
    controllerHarness.fallback = makeController({
      activeRepo: O8_REPO,
      activeTab: ORCHESTRATOR_TAB,
      tabs: [ORCHESTRATOR_TAB, TERMINAL_TAB],
    });
    terminalModeHarness.terminalTab = TERMINAL_TAB;
    terminalModeHarness.effectiveActiveTabId = TERMINAL_TAB.id;
    await mount(rootProps('tile-primary', { activeWorkspaceSurface: true }));

    const state = await readSurfaceState();
    expect(state.activeTabId).toBe('tab-gamma');
    expect(state.activeTabKind).toBe('terminal');
    expect(state.activeWorkspaceRepo).toBe('notes-app');
  });
});
