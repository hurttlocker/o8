// @vitest-environment jsdom

import { act, createElement, Fragment, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Canvas } from '@/components/desktop/Canvas';
import { useWorkspaceTerminalController } from '@/components/desktop/workspace-terminal/useWorkspaceTerminalController';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { createDefaultTileLayout, getFirstLeaf, serializeTileLayout } from '@/lib/tiles/operations';
import type { TileLayout } from '@/lib/tiles/types';
import { createTileRegistry } from '../tileRegistry';
import { useGlobalRepoState } from './useGlobalRepoState';
import { TILE_LAYOUT_STORAGE_KEY, useTileLayout } from './useTileLayout';

const REPO_PATH = '/tmp/saved-chat-repo';
const WORKTREE_PATH = '/tmp/o8-external-worktrees/saved-chat';
const SESSION_KEY = 'codex-owned:saved-chat';

function selectedRepoFromCanvasElement(element: unknown): string | null {
  if (typeof element !== 'object' || element === null) return null;
  const props = (element as { props?: { selectedRepo?: unknown; children?: unknown } }).props;
  if (typeof props?.selectedRepo === 'string') return props.selectedRepo;
  const children = Array.isArray(props?.children) ? props.children : [props?.children];
  for (const child of children) {
    const selectedRepo = selectedRepoFromCanvasElement(child);
    if (selectedRepo) return selectedRepo;
  }
  return null;
}

function registeredRepo(): RepoRegistryEntry {
  return {
    id: 'saved-chat-repo',
    name: 'saved-chat-repo',
    localPath: REPO_PATH,
    remoteUrl: 'https://github.com/example/saved-chat-repo.git',
    defaultBranch: 'main',
    addedAt: new Date(0).toISOString(),
    lastOpenedAt: null,
    storagePressureParkingDisabled: false,
    setup: {
      envMode: 'skip', envFiles: [], installCommand: null, installOnCreateWorkspace: false,
      buildCommand: null, runBuildOnCreateWorkspace: false, devCommand: null,
      defaultPort: null, workspaceIsolationPreference: 'auto',
    },
  };
}

function savedLayout(): TileLayout {
  const base = createDefaultTileLayout();
  return {
    ...base,
    root: {
      type: 'split',
      id: 'saved-root',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        { type: 'leaf', id: 'saved-terminal', content: { kind: 'terminal', repoPath: WORKTREE_PATH } },
        { type: 'leaf', id: 'saved-canvas', content: { kind: 'canvas', repoPath: WORKTREE_PATH } },
      ],
    },
  };
}

function SavedChatConsumer({
  repo,
  onSessions,
}: {
  repo: { name: string; localPath: string; branch?: string | null; registryRepoId?: string };
  onSessions: (sessions: MobileInboxSnapshot['sessions']) => void;
}) {
  const controller = useWorkspaceTerminalController({
    stateScope: 'saved-terminal',
    defaultTab: 'terminal',
    autoCreateDefaultTab: false,
    preferredRepo: repo,
    selectedRepo: repo,
    sendTerminalCreate: () => undefined,
    sendTerminalAttach: () => undefined,
    sendTerminalInput: () => undefined,
    sendTerminalResize: () => undefined,
    sendTerminalVisibility: () => undefined,
    sendTerminalDetach: () => undefined,
    termWsConnected: false,
    onChatSessionsChange: onSessions,
  }, null);
  const activeSession = controller.tabs.find((tab) => tab.kind === 'chat')?.chatSessionKey ?? '';
  return createElement(Fragment, null,
    createElement('output', { 'data-testid': 'restored-chat-session' }, activeSession),
    createElement(Canvas, {
      tabs: [], activeTabId: null, onSelectTab: () => undefined, onCloseTab: () => undefined,
      selectedRepo: 'example/saved-chat-repo',
    }),
  );
}

function RecoveryHarness({ onSessions }: { onSessions: (sessions: MobileInboxSnapshot['sessions']) => void }) {
  const [layout, setLayout] = useState(createDefaultTileLayout);
  const [activeTileId, setActiveTileId] = useState<string | null>('saved-terminal');
  const contextualPanelHandlesRef = useRef(new Map());
  const workspaceTerminalHandlesRef = useRef(new Map());
  const repos = useGlobalRepoState({
    activeWorkspace: undefined,
    setActiveNavSection: () => undefined,
    setSidebarVisible: () => undefined,
    sidebarVisible: true,
  });
  const restored = useTileLayout({
    activeTileId,
    activeWorkspaceChatSessionKey: undefined,
    contextualPanelHandlesRef,
    findInsertionTarget: () => getFirstLeaf(layout.root),
    findWorkspaceTarget: () => null,
    globalRepoEntries: repos.globalRepoEntries,
    globalRepoEntry: repos.globalRepoEntry,
    // The production hook accepts this recovery seam. Keeping the test input
    // structurally compatible with the pre-fix source lets the detached
    // baseline exercise the same mounted path for its red receipt.
    refreshRestoredRepoState: (repos as { refreshRestoredRepoState?: (paths: readonly string[]) => Promise<boolean> }).refreshRestoredRepoState,
    setActiveTileId,
    setTileLayout: setLayout,
    tileLayout: layout,
    workspaceChatTargetKeyByRepoPath: {},
    workspaceChatTargets: [],
    workspaceSidePanelRepoPath: null,
    workspaceTerminalHandlesRef,
    workspaceTerminalPreferredRepo: null,
    waitForWorkspaceTerminalTarget: async () => { throw new Error('not used by restore'); },
  } as unknown as Parameters<typeof useTileLayout>[0]);

  if (!restored.tileLayoutHydrated) return createElement('div');
  const terminal = layout.root.type === 'split' ? getFirstLeaf(layout.root.children[0]) : layout.root;
  const canvas = layout.root.type === 'split' ? getFirstLeaf(layout.root.children[1]) : layout.root;
  const registry = createTileRegistry({
    activeTileId,
    canvasStateByTileId: {},
    globalRepoEntries: repos.globalRepoEntries,
    parsedAgents: [],
    registerWorkspaceTerminalHandle: () => undefined,
    setActiveTileId,
    setTileLayout: setLayout,
    termWsConnected: false,
    thoughtsMissionState: { packets: [] },
    tileLayout: layout,
    restoredRepoValidationState: restored.restoredRepoValidationState,
    retryRestoredRepoValidation: restored.retryRestoredRepoValidation,
    workspacePreviews: [],
    workspaceScopeEntries: repos.workspaceScopeEntries,
    workspaceTerminalPreferredRepo: null,
    workspaceTerminalResetNonceByTileId: {},
    unverifiedRestoredRepoTileIds: restored.unverifiedRestoredRepoTileIds,
  } as unknown as Parameters<typeof createTileRegistry>[0]);
  const scope = repos.workspaceScopeEntries.find((entry) => entry.localPath === WORKTREE_PATH) ?? null;
  const canvasElement = registry.canvas.render({ active: true, content: canvas.content, tileId: 'saved-canvas' });
  const canvasRepo = selectedRepoFromCanvasElement(canvasElement);

  return createElement(Fragment, null,
    restored.unverifiedRestoredRepoTileIds.has('saved-terminal')
      ? registry.terminal.render({ active: true, content: terminal.content, tileId: 'saved-terminal' })
      : null,
    restored.unverifiedRestoredRepoTileIds.has('saved-canvas')
      ? canvasElement
      : null,
    scope && canvasRepo ? createElement(Fragment, null,
      createElement('output', { 'data-testid': 'restored-canvas-repo' }, canvasRepo),
      createElement(SavedChatConsumer, { repo: scope, onSessions }),
    ) : null,
  );
}

describe('saved chat recovery after a cold repository-list failure', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, serializeTileLayout(savedLayout()));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps terminal and canvas blocked, then restores the persisted chat from refreshed repo and worktree state', async () => {
    let inventoryCalls = 0;
    let validationCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.href);
      if (url.pathname === '/api/panel/repos' && url.searchParams.has('restoreValidationOnly')) {
        validationCalls += 1;
        if (validationCalls === 1) return Response.json({}, { status: 503 });
        return Response.json({ validatedRestorePaths: [{ requestedPath: WORKTREE_PATH, canonicalPath: WORKTREE_PATH }] });
      }
      if (url.pathname === '/api/panel/repos') {
        inventoryCalls += 1;
        return inventoryCalls === 1
          ? Response.json({}, { status: 503 })
          : Response.json({ repos: [registeredRepo()] });
      }
      if (url.pathname === '/api/worktrees') {
        return Response.json({
          worktrees: [{ path: WORKTREE_PATH, branch: 'saved-chat', status: 'active' }],
          conflicts: { safe: true, count: 0 }, totalDiskUsage: 0,
        });
      }
      if (url.pathname === '/api/panel/terminal-state') {
        return Response.json({
          version: 1,
          activeTabId: 'persisted-chat',
          savedAt: new Date(0).toISOString(),
          tabs: [{
            id: 'persisted-chat', label: 'Saved chat', kind: 'chat', cliAgent: 'codex',
            repoName: 'saved-chat-repo', repoPath: WORKTREE_PATH,
            chatRuntime: 'codex', chatSessionKey: SESSION_KEY,
          }],
        });
      }
      return Response.json({});
    }));
    const sessions: MobileInboxSnapshot['sessions'][] = [];

    await act(async () => root.render(createElement(RecoveryHarness, { onSessions: (value) => sessions.push(value) })));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 30)));

    const retry = container.querySelector<HTMLButtonElement>('[aria-label="Retry saved repository scope"]');
    expect(retry).not.toBeNull();
    expect(container.textContent).toContain('Couldn’t verify this saved repository scope.');
    expect(container.querySelector('[data-testid="restored-chat-session"]')).toBeNull();

    await act(async () => retry?.click());
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 80)));

    expect(container.querySelector('[data-testid="restored-chat-session"]')?.textContent).toBe(SESSION_KEY);
    expect(container.querySelector('[data-testid="restored-canvas-repo"]')?.textContent).toBe('example/saved-chat-repo');
    expect(sessions.some((value) => value.some((session) => session.sessionKey === SESSION_KEY))).toBe(true);
    expect(container.textContent).toContain('saved-chat-repo');
    expect(inventoryCalls).toBeGreaterThanOrEqual(2);
  });
});
