// @vitest-environment jsdom

import { act, createElement, StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { collectLeafNodes, createDefaultTileLayout, getFirstLeaf, serializeTileLayout } from '@/lib/tiles/operations';
import type { TileLayout } from '@/lib/tiles/types';
import { createTileRegistry } from '../tileRegistry';
import { RESTORE_VALIDATION_BUDGET_MS } from './tileLayoutRestore';
import { TILE_LAYOUT_STORAGE_KEY, useTileLayout } from './useTileLayout';

const STALE_REPO_PATH = '/tmp/first-o8-instance/repo';
const CANONICAL_REPO_PATH = '/private/tmp/first-o8-instance/repo';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workspaceBoundary = vi.hoisted(() => ({ preferredRepoPaths: [] as Array<string | null> }));

vi.mock('@/lib/react/retrying-lazy', () => ({
  retryingLazy: (_loader: unknown, options: { label?: string }) => (
    options.label === 'Workspace terminal'
      ? (props: { preferredRepo?: { localPath?: string } | null }) => {
          const repoPath = props.preferredRepo?.localPath ?? null;
          workspaceBoundary.preferredRepoPaths.push(repoPath);
          if (repoPath) {
            void fetch('/api/runtime/launch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ repoPath }),
            });
          }
          return null;
        }
      : () => null
  ),
}));

function persistedLayout(repoPath: string): TileLayout {
  return {
    ...createDefaultTileLayout(),
    root: {
      type: 'leaf',
      id: 'tile-root',
      content: { kind: 'terminal', repoPath },
    },
  };
}

function persistedTerminalCanvasLayout(repoPath: string): TileLayout {
  return {
    ...createDefaultTileLayout(),
    root: {
      type: 'split',
      id: 'saved-split',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        { type: 'leaf', id: 'saved-terminal', content: { kind: 'terminal', repoPath } },
        { type: 'leaf', id: 'saved-canvas', content: { kind: 'canvas', repoPath } },
      ],
    },
  };
}

function registeredRepo(localPath: string, id = 'repo-first'): RepoRegistryEntry {
  return {
    id,
    name: 'repo',
    localPath,
    remoteUrl: null,
    defaultBranch: 'main',
    addedAt: new Date(0).toISOString(),
    lastOpenedAt: null,
    storagePressureParkingDisabled: false,
    setup: {
      envMode: 'skip',
      envFiles: [],
      installCommand: null,
      installOnCreateWorkspace: false,
      buildCommand: null,
      runBuildOnCreateWorkspace: false,
      devCommand: null,
      defaultPort: null,
      workspaceIsolationPreference: 'auto',
    },
  };
}

function repoValidationResponse(url: string, registeredRepos: RepoRegistryEntry[]) {
  const requestedPaths = new URL(url, window.location.href).searchParams.getAll('restorePath');
  return Response.json({
    repos: registeredRepos,
    validatedRestorePaths: requestedPaths
      .filter((requestedPath) => registeredRepos.some((repo) => repo.localPath === requestedPath))
      .map((requestedPath) => ({ requestedPath, canonicalPath: requestedPath })),
  });
}

function LayoutRestoreHarness({
  onLayout,
  onReplaceLayout,
  onSplitTile,
  onResizeSplit,
  onUnverifiedIds,
  registeredRepos,
  repoInventoryRevision = 0,
  refreshRestoredRepoState = async () => true,
}: {
  onLayout: (layout: TileLayout, hydrated: boolean, validationState: string) => void;
  onReplaceLayout?: (replaceLayout: (layout: TileLayout) => void) => void;
  onSplitTile?: (split: (tileId: string) => void) => void;
  onResizeSplit?: (resize: (splitId: string, ratio: number) => void) => void;
  onUnverifiedIds?: (ids: ReadonlySet<string>) => void;
  registeredRepos: RepoRegistryEntry[];
  repoInventoryRevision?: number;
  refreshRestoredRepoState?: (validatedPaths: readonly string[]) => Promise<boolean>;
}) {
  const [layout, setLayout] = useState(createDefaultTileLayout);
  const [activeTileId, setActiveTileId] = useState<string | null>('tile-root');
  const contextualPanelHandlesRef = useRef(new Map());
  const workspaceTerminalHandlesRef = useRef(new Map());
  const restored = useTileLayout({
    activeTileId,
    activeWorkspaceChatSessionKey: undefined,
    contextualPanelHandlesRef,
    findInsertionTarget: () => getFirstLeaf(layout.root),
    findWorkspaceTarget: () => null,
    globalRepoEntries: registeredRepos,
    globalRepoEntry: null,
    refreshRestoredRepoState,
    repoInventoryRevision,
    setActiveTileId,
    setTileLayout: setLayout,
    tileLayout: layout,
    workspaceChatTargetKeyByRepoPath: {},
    workspaceChatTargets: [],
    workspaceSidePanelRepoPath: null,
    workspaceTerminalHandlesRef,
    workspaceTerminalPreferredRepo: null,
    waitForWorkspaceTerminalTarget: async () => {
      throw new Error('not used by layout restoration');
    },
  });

  const { handleSplitTile, handleResizeSplit } = restored;

  useEffect(() => {
    onLayout(layout, restored.tileLayoutHydrated, restored.restoredRepoValidationState);
  }, [layout, onLayout, restored.restoredRepoValidationState, restored.tileLayoutHydrated]);

  useEffect(() => {
    onReplaceLayout?.(setLayout);
  }, [onReplaceLayout]);

  useEffect(() => {
    onSplitTile?.((tileId) => handleSplitTile(tileId, 'horizontal'));
  }, [onSplitTile, handleSplitTile]);

  useEffect(() => {
    onUnverifiedIds?.(restored.unverifiedRestoredRepoTileIds);
  }, [onUnverifiedIds, restored.unverifiedRestoredRepoTileIds]);

  useEffect(() => {
    onResizeSplit?.((splitId, ratio) => handleResizeSplit(splitId, ratio));
  }, [onResizeSplit, handleResizeSplit]);

  if (!restored.tileLayoutHydrated) return createElement('div');
  const leaf = getFirstLeaf(layout.root);
  const registry = createTileRegistry({
    activeTileId,
    canvasStateByTileId: {},
    globalRepoEntries: [],
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
    workspaceScopeEntries: registeredRepos.map((repo) => ({
      registryRepoId: repo.id,
      name: repo.name,
      localPath: repo.localPath,
    })),
    workspaceTerminalPreferredRepo: null,
    workspaceTerminalResetNonceByTileId: {},
    unverifiedRestoredRepoTileIds: restored.unverifiedRestoredRepoTileIds,
  } as unknown as Parameters<typeof createTileRegistry>[0]);
  return registry.terminal.render({ active: true, content: leaf.content, tileId: leaf.id });
}

describe('useTileLayout browser-origin restore', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    workspaceBoundary.preferredRepoPaths = [];
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

  it('keeps the real registry consumer blocked from the first hydrated render through an unresolved split', async () => {
    window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, serializeTileLayout(persistedLayout(STALE_REPO_PATH)));
    const registeredRepos = [registeredRepo(STALE_REPO_PATH)];
    const runtimeLaunches: string[] = [];
    let completeInitialValidation: ((response: Response) => void) | null = null;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/panel/repos')) {
        return new Promise<Response>((resolve) => { completeInitialValidation = resolve; });
      }
      if (url.startsWith('/api/runtime/launch')) runtimeLaunches.push(url);
      return Promise.resolve(Response.json({}));
    }));

    let hydrated = false;
    let splitTile: ((tileId: string) => void) | null = null;
    const onLayout = (_layout: TileLayout, nextHydrated: boolean) => { hydrated = nextHydrated; };
    await act(async () => root.render(createElement(LayoutRestoreHarness, {
      onLayout,
      onSplitTile: (split) => { splitTile = split; },
      registeredRepos,
    })));
    // Flush only the synchronous seed effect — the validation network call
    // is deliberately left unresolved.
    await act(async () => { await Promise.resolve(); });

    expect(hydrated).toBe(true);
    // The REAL registry consumer, on its very first hydrated render — well
    // before validation resolves either way — must already show the
    // blocked/pending status, never the live WorkspaceTerminal (which would
    // otherwise launch against an unverified repo path).
    expect(container.textContent).toContain('Verifying saved repository scope');
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Retry saved repository scope"]')?.disabled).toBe(true);
    expect(runtimeLaunches).toEqual([]);
    expect(workspaceBoundary.preferredRepoPaths).toEqual([]);

    // An actual split of the still-unverified leaf while validation remains
    // unresolved: the original leaf (still first in the tree) must stay
    // blocked in the real render, and the still-pending path must not leak
    // through the real terminal via either leaf.
    await act(async () => splitTile?.('tile-root'));
    expect(container.textContent).toContain('Verifying saved repository scope');
    expect(runtimeLaunches).toEqual([]);
    expect(workspaceBoundary.preferredRepoPaths).toEqual([]);

    await act(async () => {
      completeInitialValidation?.(Response.json({}, { status: 503 }));
      await Promise.resolve();
    });
  });

  it('blocks a brand-new tile id that later carries the same still-unverified repo path', async () => {
    window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, serializeTileLayout(persistedLayout(STALE_REPO_PATH)));
    const registeredRepos = [registeredRepo(STALE_REPO_PATH)];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/panel/repos')) return Response.json({}, { status: 503 });
      return Response.json({});
    }));

    let replaceLayout: ((layout: TileLayout) => void) | null = null;
    let unverifiedIds = new Set<string>();
    const onLayout = () => undefined;
    await act(async () => root.render(createElement(LayoutRestoreHarness, {
      onLayout,
      onReplaceLayout: (replace) => { replaceLayout = replace; },
      onUnverifiedIds: (ids) => { unverifiedIds = new Set(ids); },
      registeredRepos,
    })));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)));

    // The ORIGINAL restored leaf ('tile-root') has failed validation.
    expect(unverifiedIds.has('tile-root')).toBe(true);

    // A brand-new tile id — never part of the original restored snapshot —
    // gets assigned the exact same still-unverified path (e.g. a canvas
    // scope reassignment, or any future split/copy path). Blocking is a
    // property of the PATH, so this new id must be blocked too, and a
    // sibling leaf pointed at a genuinely different, never-blocked path
    // must not be.
    await act(async () => replaceLayout?.({
      ...createDefaultTileLayout(),
      root: {
        type: 'split',
        id: 'new-split',
        direction: 'horizontal',
        ratio: 0.5,
        children: [
          { type: 'leaf', id: 'tile-root', content: { kind: 'terminal', repoPath: STALE_REPO_PATH } },
          { type: 'leaf', id: 'brand-new-leaf', content: { kind: 'terminal', repoPath: STALE_REPO_PATH } },
        ],
      },
    }));

    expect(unverifiedIds.has('tile-root')).toBe(true);
    expect(unverifiedIds.has('brand-new-leaf')).toBe(true);

    await act(async () => replaceLayout?.({
      ...createDefaultTileLayout(),
      root: {
        type: 'split',
        id: 'new-split',
        direction: 'horizontal',
        ratio: 0.5,
        children: [
          { type: 'leaf', id: 'tile-root', content: { kind: 'terminal', repoPath: STALE_REPO_PATH } },
          { type: 'leaf', id: 'unrelated-leaf', content: { kind: 'terminal', repoPath: '/tmp/never-blocked/repo' } },
        ],
      },
    }));

    expect(unverifiedIds.has('unrelated-leaf')).toBe(false);
  });

  it('drops a repo scope from another local server before the workspace can restore it', async () => {
    window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, serializeTileLayout(persistedLayout(STALE_REPO_PATH)));
    let registeredRepos: RepoRegistryEntry[] = [registeredRepo(CANONICAL_REPO_PATH)];
    const runtimeLaunches: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/panel/repos')) {
        const requestedPath = new URL(url, window.location.href).searchParams.get('restorePath');
        return Response.json({
          repos: registeredRepos,
          validatedRestorePaths: registeredRepos.length > 0 && requestedPath
            ? [{ requestedPath, canonicalPath: CANONICAL_REPO_PATH }]
            : [],
        });
      }
      if (url.startsWith('/api/runtime/launch')) runtimeLaunches.push(url);
      return Response.json({});
    }));

    let latestLayout = createDefaultTileLayout();
    let hydrated = false;
    const onLayout = (layout: TileLayout, nextHydrated: boolean) => {
      latestLayout = layout;
      hydrated = nextHydrated;
    };

    await act(async () => root.render(createElement(LayoutRestoreHarness, { onLayout, registeredRepos })));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)));
    expect(hydrated).toBe(true);
    expect(getFirstLeaf(latestLayout.root).content).toMatchObject({ repoPath: CANONICAL_REPO_PATH });
    expect(workspaceBoundary.preferredRepoPaths.at(-1)).toBe(CANONICAL_REPO_PATH);
    expect(runtimeLaunches).toContain('/api/runtime/launch');

    await act(async () => root.unmount());
    root = createRoot(container);
    registeredRepos = [];
    workspaceBoundary.preferredRepoPaths = [];
    runtimeLaunches.length = 0;

    await act(async () => root.render(createElement(LayoutRestoreHarness, { onLayout, registeredRepos })));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)));

    expect(hydrated).toBe(true);
    expect(getFirstLeaf(latestLayout.root).content).toMatchObject({ repoPath: null });
    expect(workspaceBoundary.preferredRepoPaths).toEqual([null]);
    expect(runtimeLaunches).toEqual([]);
  });

  it('fails closed without erasing the stored layout when registry validation is unavailable', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, serializeTileLayout(persistedLayout(STALE_REPO_PATH)));
    const runtimeLaunches: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/panel/repos')) return Response.json({}, { status: 503 });
      if (url.startsWith('/api/runtime/launch')) runtimeLaunches.push(url);
      return Response.json({});
    }));

    let latestLayout = createDefaultTileLayout();
    let hydrated = false;
    const onLayout = (layout: TileLayout, nextHydrated: boolean) => {
      latestLayout = layout;
      hydrated = nextHydrated;
    };

    const registeredRepos = [registeredRepo(STALE_REPO_PATH)];
    try {
      await act(async () => root.render(createElement(LayoutRestoreHarness, { onLayout, registeredRepos })));
      await act(async () => vi.advanceTimersByTimeAsync(RESTORE_VALIDATION_BUDGET_MS + 100));

      expect(hydrated).toBe(true);
      expect(getFirstLeaf(latestLayout.root).content).toMatchObject({ repoPath: STALE_REPO_PATH });
      const stored = JSON.parse(window.localStorage.getItem(TILE_LAYOUT_STORAGE_KEY) ?? 'null') as TileLayout | null;
      expect(stored && getFirstLeaf(stored.root).content).toMatchObject({ repoPath: STALE_REPO_PATH });
      expect(workspaceBoundary.preferredRepoPaths).toEqual([]);
      expect(container.textContent).toContain('Couldn’t verify this saved repository scope.');
      expect(runtimeLaunches).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a failed saved scope from the rendered tile without remounting', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, serializeTileLayout(persistedLayout(STALE_REPO_PATH)));
    const registeredRepos = [registeredRepo(STALE_REPO_PATH)];
    const runtimeLaunches: string[] = [];
    let validationCalls = 0;
    let validationFailing = true;
    let completeRetry: ((response: Response) => void) | null = null;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/panel/repos')) {
        validationCalls += 1;
        if (validationFailing) return Promise.resolve(Response.json({}, { status: 503 }));
        return new Promise<Response>((resolve) => { completeRetry = resolve; });
      }
      if (url.startsWith('/api/runtime/launch')) runtimeLaunches.push(url);
      return Promise.resolve(Response.json({}));
    }));

    let latestLayout = createDefaultTileLayout();
    let hydrated = false;
    let validationState = 'idle';
    const onLayout = (layout: TileLayout, nextHydrated: boolean, nextValidationState: string) => {
      latestLayout = layout;
      hydrated = nextHydrated;
      validationState = nextValidationState;
    };

    try {
      await act(async () => root.render(createElement(LayoutRestoreHarness, { onLayout, registeredRepos })));
      await act(async () => vi.advanceTimersByTimeAsync(RESTORE_VALIDATION_BUDGET_MS + 100));

      expect(hydrated).toBe(true);
      expect(validationState).toBe('failed');
      expect(getFirstLeaf(latestLayout.root).content).toMatchObject({ repoPath: STALE_REPO_PATH });
      expect(runtimeLaunches).toEqual([]);
      const retryButton = container.querySelector<HTMLButtonElement>('button[aria-label="Retry saved repository scope"]');
      expect(retryButton).not.toBeNull();

      const callsBeforeRetry = validationCalls;
      validationFailing = false;
      await act(async () => retryButton?.click());
      expect(validationState).toBe('pending');
      expect(retryButton?.disabled).toBe(true);
      expect(runtimeLaunches).toEqual([]);

      await act(async () => {
        completeRetry?.(repoValidationResponse(`/api/panel/repos?restorePath=${encodeURIComponent(STALE_REPO_PATH)}`, registeredRepos));
        await Promise.resolve();
      });

      expect(validationCalls).toBe(callsBeforeRetry + 1);
      expect(validationState).toBe('verified');
      expect(getFirstLeaf(latestLayout.root).content).toMatchObject({ repoPath: STALE_REPO_PATH });
      expect(workspaceBoundary.preferredRepoPaths).toEqual([STALE_REPO_PATH]);
      expect(runtimeLaunches).toContain('/api/runtime/launch');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a retry response after the operator changes the restored repo scope', async () => {
    vi.useFakeTimers();
    const newerRepoPath = '/tmp/newer-o8-instance/repo';
    window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, serializeTileLayout(persistedLayout(STALE_REPO_PATH)));
    const registeredRepos = [registeredRepo(STALE_REPO_PATH)];
    let validationCalls = 0;
    let validationFailing = true;
    let completeRetry: ((response: Response) => void) | null = null;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.startsWith('/api/panel/repos')) return Promise.resolve(Response.json({}));
      validationCalls += 1;
      if (validationFailing) return Promise.resolve(Response.json({}, { status: 503 }));
      return new Promise<Response>((resolve) => { completeRetry = resolve; });
    }));

    let latestLayout = createDefaultTileLayout();
    let replaceLayout: ((layout: TileLayout) => void) | null = null;
    const onLayout = (layout: TileLayout) => { latestLayout = layout; };
    try {
      await act(async () => root.render(createElement(LayoutRestoreHarness, {
        onLayout,
        onReplaceLayout: (replace) => { replaceLayout = replace; },
        registeredRepos,
      })));
      await act(async () => vi.advanceTimersByTimeAsync(RESTORE_VALIDATION_BUDGET_MS + 100));

      const callsBeforeRetry = validationCalls;
      validationFailing = false;
      const retryButton = container.querySelector<HTMLButtonElement>('button[aria-label="Retry saved repository scope"]');
      await act(async () => retryButton?.click());
      await act(async () => replaceLayout?.(persistedLayout(newerRepoPath)));
      await act(async () => {
        completeRetry?.(repoValidationResponse(`/api/panel/repos?restorePath=${encodeURIComponent(STALE_REPO_PATH)}`, registeredRepos));
        await Promise.resolve();
      });

      expect(validationCalls).toBe(callsBeforeRetry + 1);
      expect(getFirstLeaf(latestLayout.root).content).toMatchObject({ repoPath: newerRepoPath });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps saved terminal and canvas scopes when the operator splits AND resizes during initial validation', async () => {
    window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, serializeTileLayout(persistedTerminalCanvasLayout(STALE_REPO_PATH)));
    const registeredRepos = [registeredRepo(STALE_REPO_PATH)];
    let completeInitialValidation: ((response: Response) => void) | null = null;
    let validationCalls = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.startsWith('/api/panel/repos')) return Promise.resolve(Response.json({}));
      validationCalls += 1;
      if (validationCalls === 1) return new Promise<Response>((resolve) => { completeInitialValidation = resolve; });
      return Promise.resolve(repoValidationResponse(url, registeredRepos));
    }));

    let latestLayout = createDefaultTileLayout();
    let hydrated = false;
    let splitTile: ((tileId: string) => void) | null = null;
    let resizeSplit: ((splitId: string, ratio: number) => void) | null = null;
    const onLayout = (layout: TileLayout, nextHydrated: boolean) => {
      latestLayout = layout;
      hydrated = nextHydrated;
    };
    await act(async () => root.render(createElement(LayoutRestoreHarness, {
      onLayout,
      onSplitTile: (split) => { splitTile = split; },
      onResizeSplit: (resize) => { resizeSplit = resize; },
      registeredRepos,
    })));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)));

    // Two DIFFERENT live actions land while the initial validation for the
    // restored layout is still in flight — a split (real handleSplitTile)
    // followed by a resize (real handleResizeSplit). The old queued-split
    // replay matched on the split's captured "expectedLayout" object
    // identity, which the resize invalidates the moment it fires; the fix
    // must not depend on replaying anything at all.
    await act(async () => splitTile?.('saved-terminal'));
    await act(async () => resizeSplit?.('saved-split', 0.7));
    await act(async () => {
      completeInitialValidation?.(repoValidationResponse(`/api/panel/repos?restorePath=${encodeURIComponent(STALE_REPO_PATH)}`, registeredRepos));
      await Promise.resolve();
    });

    expect(hydrated).toBe(true);
    expect(collectLeafNodes(latestLayout.root).map((leaf) => leaf.content)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'terminal', repoPath: STALE_REPO_PATH }),
      expect.objectContaining({ kind: 'canvas', repoPath: STALE_REPO_PATH }),
    ]));
    expect(collectLeafNodes(latestLayout.root)).toHaveLength(3);
    expect(container.querySelector('button[aria-label="Retry saved repository scope"]')).not.toBeNull();
    expect(window.localStorage.getItem(TILE_LAYOUT_STORAGE_KEY)).toContain(STALE_REPO_PATH);

    await act(async () => splitTile?.('saved-terminal'));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
    const storedAfterSecondSplit = window.localStorage.getItem(TILE_LAYOUT_STORAGE_KEY);
    expect(storedAfterSecondSplit).toContain(STALE_REPO_PATH);
    expect(validationCalls).toBe(1);

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Retry saved repository scope"]')?.click());
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)));
    expect(validationCalls).toBe(2);
    expect(collectLeafNodes(latestLayout.root).map((leaf) => leaf.content)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'terminal', repoPath: STALE_REPO_PATH }),
      expect.objectContaining({ kind: 'canvas', repoPath: STALE_REPO_PATH }),
    ]));
  });

  it('keeps a newly chosen repo scope and its split when a stale initial validation resolves last', async () => {
    const newerRepoPath = '/tmp/newer-o8-instance/repo';
    window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, serializeTileLayout(persistedLayout(STALE_REPO_PATH)));
    const registeredRepos = [registeredRepo(STALE_REPO_PATH), registeredRepo(newerRepoPath, 'repo-newer')];
    let completeInitialValidation: ((response: Response) => void) | null = null;
    let validationCalls = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.startsWith('/api/panel/repos')) return Promise.resolve(Response.json({}));
      validationCalls += 1;
      if (validationCalls === 1) return new Promise<Response>((resolve) => { completeInitialValidation = resolve; });
      return Promise.resolve(repoValidationResponse(url, registeredRepos));
    }));

    let latestLayout = createDefaultTileLayout();
    let replaceLayout: ((layout: TileLayout) => void) | null = null;
    let splitTile: ((tileId: string) => void) | null = null;
    const onLayout = (layout: TileLayout) => { latestLayout = layout; };
    await act(async () => root.render(createElement(LayoutRestoreHarness, {
      onLayout,
      onReplaceLayout: (replace) => { replaceLayout = replace; },
      onSplitTile: (split) => { splitTile = split; },
      registeredRepos,
    })));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)));

    // The operator abandons the saved STALE scope entirely for a different
    // repo, then splits the tile they're now looking at, all BEFORE the
    // original (now-irrelevant) validation resolves.
    await act(async () => replaceLayout?.(persistedLayout(newerRepoPath)));
    await act(async () => splitTile?.('tile-root'));
    await act(async () => {
      completeInitialValidation?.(repoValidationResponse(`/api/panel/repos?restorePath=${encodeURIComponent(STALE_REPO_PATH)}`, registeredRepos));
      await Promise.resolve();
    });

    // The newer choice AND the split it made survive intact — nothing
    // resurrects the discarded STALE_REPO_PATH tree.
    expect(collectLeafNodes(latestLayout.root)).toHaveLength(2);
    expect(collectLeafNodes(latestLayout.root).some((leaf) => (
      leaf.content.kind === 'terminal' && leaf.content.repoPath === newerRepoPath
    ))).toBe(true);
    expect(collectLeafNodes(latestLayout.root).some((leaf) => (
      'repoPath' in leaf.content && leaf.content.repoPath === STALE_REPO_PATH
    ))).toBe(false);
  });

  it('ignores a completed repository refresh after the operator changes the restored repo scope', async () => {
    const newerRepoPath = '/tmp/newer-o8-instance/repo';
    window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, serializeTileLayout(persistedLayout(STALE_REPO_PATH)));
    const registeredRepos = [registeredRepo(STALE_REPO_PATH)];
    let validationCalls = 0;
    let validationFailing = true;
    let completeRefresh: ((available: boolean) => void) | null = null;
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.startsWith('/api/panel/repos')) return Response.json({});
      validationCalls += 1;
      return validationFailing
        ? Response.json({}, { status: 503 })
        : repoValidationResponse(url, registeredRepos);
    }));

    let latestLayout = createDefaultTileLayout();
    let validationState = 'idle';
    let replaceLayout: ((layout: TileLayout) => void) | null = null;
    const onLayout = (layout: TileLayout, _hydrated: boolean, nextValidationState: string) => {
      latestLayout = layout;
      validationState = nextValidationState;
    };
    const refreshRestoredRepoState = () => new Promise<boolean>((resolve) => { completeRefresh = resolve; });
    try {
      await act(async () => root.render(createElement(LayoutRestoreHarness, {
        onLayout,
        onReplaceLayout: (replace) => { replaceLayout = replace; },
        refreshRestoredRepoState,
        registeredRepos,
      })));
      await act(async () => vi.advanceTimersByTimeAsync(RESTORE_VALIDATION_BUDGET_MS + 100));

      const callsBeforeRetry = validationCalls;
      validationFailing = false;
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Retry saved repository scope"]')?.click());
      await act(async () => replaceLayout?.(persistedLayout(newerRepoPath)));
      await act(async () => {
        completeRefresh?.(true);
        await Promise.resolve();
      });

      expect(validationCalls).toBe(callsBeforeRetry + 1);
      expect(validationState).toBe('idle');
      expect(getFirstLeaf(latestLayout.root).content).toMatchObject({ repoPath: newerRepoPath });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the newer layout render and launch immediately when initial validation becomes stale', async () => {
    const newerRepoPath = '/tmp/newer-o8-instance/repo';
    const registeredRepos = [registeredRepo(STALE_REPO_PATH), registeredRepo(newerRepoPath, 'repo-newer')];
    window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, serializeTileLayout(persistedLayout(STALE_REPO_PATH)));
    const runtimeLaunches: string[] = [];
    let completeInitialValidation: ((response: Response) => void) | null = null;
    let validationCalls = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/panel/repos')) {
        validationCalls += 1;
        if (validationCalls === 1) return new Promise<Response>((resolve) => { completeInitialValidation = resolve; });
        return Promise.resolve(repoValidationResponse(url, registeredRepos));
      }
      if (url.startsWith('/api/runtime/launch')) runtimeLaunches.push(url);
      return Promise.resolve(Response.json({}));
    }));

    let latestLayout = createDefaultTileLayout();
    let hydrated = false;
    let replaceLayout: ((layout: TileLayout) => void) | null = null;
    const onLayout = (layout: TileLayout, nextHydrated: boolean) => {
      latestLayout = layout;
      hydrated = nextHydrated;
    };
    await act(async () => root.render(createElement(LayoutRestoreHarness, {
      onLayout,
      onReplaceLayout: (replace) => { replaceLayout = replace; },
      registeredRepos,
    })));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)));
    // The operator abandons the saved STALE scope for a different,
    // already-registered repo BEFORE the original (now-irrelevant)
    // validation resolves. The newer choice is not held hostage by it.
    await act(async () => replaceLayout?.(persistedLayout(newerRepoPath)));
    await act(async () => {
      completeInitialValidation?.(repoValidationResponse(`/api/panel/repos?restorePath=${encodeURIComponent(STALE_REPO_PATH)}`, registeredRepos));
      await Promise.resolve();
    });

    expect(hydrated).toBe(true);
    expect(getFirstLeaf(latestLayout.root).content).toMatchObject({ repoPath: newerRepoPath });
    expect(runtimeLaunches).toContain('/api/runtime/launch');
    expect(container.querySelector('button[aria-label="Retry saved repository scope"]')).toBeNull();
  });

  it('hydrates successfully when StrictMode replays the restore lifecycle', async () => {
    const registeredRepos = [registeredRepo(STALE_REPO_PATH)];
    window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, serializeTileLayout(persistedLayout(STALE_REPO_PATH)));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/panel/repos')) return repoValidationResponse(url, registeredRepos);
      return Response.json({});
    }));

    let latestLayout = createDefaultTileLayout();
    let hydrated = false;
    const onLayout = (layout: TileLayout, nextHydrated: boolean) => {
      latestLayout = layout;
      hydrated = nextHydrated;
    };
    await act(async () => root.render(createElement(StrictMode, null, createElement(LayoutRestoreHarness, { onLayout, registeredRepos }))));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)));

    expect(hydrated).toBe(true);
    expect(getFirstLeaf(latestLayout.root).content).toMatchObject({ repoPath: STALE_REPO_PATH });
  });

  it('preserves a persisted repo scope but blocks launch when validation times out', async () => {
    vi.useFakeTimers();
    try {
      window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, serializeTileLayout(persistedLayout(STALE_REPO_PATH)));
      const registeredRepos = [registeredRepo(STALE_REPO_PATH)];
      const runtimeLaunches: string[] = [];
      vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith('/api/panel/repos')) return new Promise<Response>(() => undefined);
        if (url.startsWith('/api/runtime/launch')) runtimeLaunches.push(url);
        return Promise.resolve(Response.json({}));
      }));

      let latestLayout = createDefaultTileLayout();
      let hydrated = false;
      const onLayout = (layout: TileLayout, nextHydrated: boolean) => {
        latestLayout = layout;
        hydrated = nextHydrated;
      };

      await act(async () => root.render(createElement(LayoutRestoreHarness, { onLayout, registeredRepos })));
      await act(async () => vi.advanceTimersByTimeAsync(RESTORE_VALIDATION_BUDGET_MS + 100));

      expect(hydrated).toBe(true);
      expect(getFirstLeaf(latestLayout.root).content).toMatchObject({ repoPath: STALE_REPO_PATH });
      const stored = JSON.parse(window.localStorage.getItem(TILE_LAYOUT_STORAGE_KEY) ?? 'null') as TileLayout | null;
      expect(stored && getFirstLeaf(stored.root).content).toMatchObject({ repoPath: STALE_REPO_PATH });
      expect(workspaceBoundary.preferredRepoPaths).toEqual([]);
      expect(container.textContent).toContain('Couldn’t verify this saved repository scope.');
      expect(runtimeLaunches).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a persisted traversal that lexically escapes a registered repo', async () => {
    const registeredPath = '/tmp/registered/repo';
    const traversalPath = `${registeredPath}/../unregistered`;
    const registeredRepos = [registeredRepo(registeredPath)];
    window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, serializeTileLayout(persistedLayout(traversalPath)));
    const runtimeLaunches: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/panel/repos')) return repoValidationResponse(url, []);
      if (url.startsWith('/api/runtime/launch')) runtimeLaunches.push(url);
      return Response.json({});
    }));

    let latestLayout = createDefaultTileLayout();
    let hydrated = false;
    const onLayout = (layout: TileLayout, nextHydrated: boolean) => {
      latestLayout = layout;
      hydrated = nextHydrated;
    };

    await act(async () => root.render(createElement(LayoutRestoreHarness, { onLayout, registeredRepos })));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)));

    expect(hydrated).toBe(true);
    expect(getFirstLeaf(latestLayout.root).content).toMatchObject({ repoPath: null });
    expect(workspaceBoundary.preferredRepoPaths).toEqual([null]);
    expect(runtimeLaunches).toEqual([]);
  });

  it('verifies a saved scope with zero clicks when the first cold attempt times out', async () => {
    vi.useFakeTimers();
    const attemptLogs: string[] = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      attemptLogs.push(args.map((arg) => String(arg)).join(' '));
    });
    window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, serializeTileLayout(persistedLayout(STALE_REPO_PATH)));
    const registeredRepos = [registeredRepo(STALE_REPO_PATH)];
    const runtimeLaunches: string[] = [];
    let validationCalls = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/panel/repos')) {
        validationCalls += 1;
        // The cold first request after launch never answers; the second one does.
        if (validationCalls === 1) return new Promise<Response>(() => undefined);
        return Promise.resolve(repoValidationResponse(url, registeredRepos));
      }
      if (url.startsWith('/api/runtime/launch')) runtimeLaunches.push(url);
      return Promise.resolve(Response.json({}));
    }));

    const observedStates: string[] = [];
    let latestLayout = createDefaultTileLayout();
    const onLayout = (layout: TileLayout, _hydrated: boolean, nextValidationState: string) => {
      latestLayout = layout;
      observedStates.push(nextValidationState);
    };

    try {
      await act(async () => root.render(createElement(LayoutRestoreHarness, { onLayout, registeredRepos })));
      await act(async () => vi.advanceTimersByTimeAsync(100));

      // Still inside the first attempt: the placeholder says "verifying", and
      // nothing has launched against the unverified path.
      expect(container.textContent).toContain('Verifying saved repository scope');
      expect(container.textContent).not.toContain('Couldn’t verify this saved repository scope.');
      expect(runtimeLaunches).toEqual([]);
      expect(workspaceBoundary.preferredRepoPaths).toEqual([]);

      // First attempt times out at 7s, the 1s backoff elapses, the second
      // attempt answers — with no Retry click anywhere in this test.
      await act(async () => vi.advanceTimersByTimeAsync(8_100));

      expect(validationCalls).toBe(2);
      expect(observedStates).not.toContain('failed');
      expect(observedStates.at(-1)).toBe('verified');
      expect(container.textContent).not.toContain('Couldn’t verify this saved repository scope.');
      expect(getFirstLeaf(latestLayout.root).content).toMatchObject({ repoPath: STALE_REPO_PATH });
      expect(workspaceBoundary.preferredRepoPaths).toEqual([STALE_REPO_PATH]);
      expect(runtimeLaunches).toContain('/api/runtime/launch');

      // One line per attempt, with the failure class and the duration.
      const timeoutLog = attemptLogs.find((line) => line.startsWith('[tile-restore] validation attempt 1:'));
      expect(timeoutLog).toBeDefined();
      const timeoutMatch = timeoutLog?.match(/^\[tile-restore\] validation attempt 1: timeout in (\d+)ms$/);
      expect(timeoutMatch).not.toBeNull();
      expect(Number(timeoutMatch?.[1])).toBeGreaterThanOrEqual(7_000);
      expect(attemptLogs.some((line) => /^\[tile-restore\] validation attempt 2: ok in \d+ms$/.test(line))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces the failed placeholder only after the budget, then re-validates on retry, repo inventory, and focus', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, serializeTileLayout(persistedLayout(STALE_REPO_PATH)));
    const registeredRepos = [registeredRepo(STALE_REPO_PATH)];
    const runtimeLaunches: string[] = [];
    let validationCalls = 0;
    let validationFailing = true;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/panel/repos')) {
        validationCalls += 1;
        return Promise.resolve(validationFailing
          ? Response.json({}, { status: 503 })
          : repoValidationResponse(url, registeredRepos));
      }
      if (url.startsWith('/api/runtime/launch')) runtimeLaunches.push(url);
      return Promise.resolve(Response.json({}));
    }));

    let validationState = 'idle';
    const onLayout = (_layout: TileLayout, _hydrated: boolean, nextValidationState: string) => {
      validationState = nextValidationState;
    };
    const renderHarness = (repoInventoryRevision: number) => root.render(createElement(LayoutRestoreHarness, {
      onLayout,
      registeredRepos,
      repoInventoryRevision,
    }));

    try {
      await act(async () => renderHarness(1));
      await act(async () => vi.advanceTimersByTimeAsync(RESTORE_VALIDATION_BUDGET_MS - 1_000));

      // Attempts keep failing, but the operator still sees "verifying" — the
      // dead-end placeholder is not allowed to appear inside the budget.
      expect(validationCalls).toBeGreaterThan(1);
      expect(validationState).toBe('pending');
      expect(container.textContent).toContain('Verifying saved repository scope');

      await act(async () => vi.advanceTimersByTimeAsync(1_200));
      expect(validationState).toBe('failed');
      expect(container.textContent).toContain('Couldn’t verify this saved repository scope.');
      expect(runtimeLaunches).toEqual([]);

      // A window focus re-validates on its own, with no click.
      const callsBeforeFocus = validationCalls;
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(validationCalls).toBe(callsBeforeFocus + 1);
      expect(validationState).toBe('failed');

      // The Retry button still works.
      const callsBeforeRetry = validationCalls;
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Retry saved repository scope"]')?.click());
      await act(async () => vi.advanceTimersByTimeAsync(50));
      expect(validationCalls).toBe(callsBeforeRetry + 1);
      expect(validationState).toBe('failed');

      // A completed repo-inventory load re-validates on its own, with no click.
      validationFailing = false;
      const callsBeforeInventory = validationCalls;
      await act(async () => renderHarness(2));
      await act(async () => vi.advanceTimersByTimeAsync(50));

      expect(validationCalls).toBe(callsBeforeInventory + 1);
      expect(validationState).toBe('verified');
      expect(workspaceBoundary.preferredRepoPaths).toEqual([STALE_REPO_PATH]);
      expect(runtimeLaunches).toContain('/api/runtime/launch');
    } finally {
      vi.useRealTimers();
    }
  });
});
