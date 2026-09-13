// @vitest-environment jsdom

import { act, createElement, StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { createDefaultTileLayout, getFirstLeaf, serializeTileLayout } from '@/lib/tiles/operations';
import type { TileLayout } from '@/lib/tiles/types';
import { createTileRegistry } from '../tileRegistry';
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
  registeredRepos,
  refreshRestoredRepoState = async () => true,
}: {
  onLayout: (layout: TileLayout, hydrated: boolean, validationState: string) => void;
  onReplaceLayout?: (replaceLayout: (layout: TileLayout) => void) => void;
  registeredRepos: RepoRegistryEntry[];
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

  useEffect(() => {
    onLayout(layout, restored.tileLayoutHydrated, restored.restoredRepoValidationState);
  }, [layout, onLayout, restored.restoredRepoValidationState, restored.tileLayoutHydrated]);

  useEffect(() => {
    onReplaceLayout?.(setLayout);
  }, [onReplaceLayout]);

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
    await act(async () => root.render(createElement(LayoutRestoreHarness, { onLayout, registeredRepos })));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)));

    expect(hydrated).toBe(true);
    expect(getFirstLeaf(latestLayout.root).content).toMatchObject({ repoPath: STALE_REPO_PATH });
    const stored = JSON.parse(window.localStorage.getItem(TILE_LAYOUT_STORAGE_KEY) ?? 'null') as TileLayout | null;
    expect(stored && getFirstLeaf(stored.root).content).toMatchObject({ repoPath: STALE_REPO_PATH });
    expect(workspaceBoundary.preferredRepoPaths).toEqual([]);
    expect(container.textContent).toContain('Couldn’t verify this saved repository scope.');
    expect(runtimeLaunches).toEqual([]);
  });

  it('retries a failed saved scope from the rendered tile without remounting', async () => {
    window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, serializeTileLayout(persistedLayout(STALE_REPO_PATH)));
    const registeredRepos = [registeredRepo(STALE_REPO_PATH)];
    const runtimeLaunches: string[] = [];
    let validationCalls = 0;
    let completeRetry: ((response: Response) => void) | null = null;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/panel/repos')) {
        validationCalls += 1;
        if (validationCalls === 1) return Promise.resolve(Response.json({}, { status: 503 }));
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

    await act(async () => root.render(createElement(LayoutRestoreHarness, { onLayout, registeredRepos })));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)));

    expect(hydrated).toBe(true);
    expect(validationState).toBe('failed');
    expect(getFirstLeaf(latestLayout.root).content).toMatchObject({ repoPath: STALE_REPO_PATH });
    expect(runtimeLaunches).toEqual([]);
    const retryButton = container.querySelector<HTMLButtonElement>('button[aria-label="Retry saved repository scope"]');
    expect(retryButton).not.toBeNull();

    await act(async () => retryButton?.click());
    expect(validationState).toBe('pending');
    expect(retryButton?.disabled).toBe(true);
    expect(runtimeLaunches).toEqual([]);

    await act(async () => {
      completeRetry?.(repoValidationResponse(`/api/panel/repos?restorePath=${encodeURIComponent(STALE_REPO_PATH)}`, registeredRepos));
      await Promise.resolve();
    });

    expect(validationCalls).toBe(2);
    expect(validationState).toBe('verified');
    expect(getFirstLeaf(latestLayout.root).content).toMatchObject({ repoPath: STALE_REPO_PATH });
    expect(workspaceBoundary.preferredRepoPaths).toEqual([STALE_REPO_PATH]);
    expect(runtimeLaunches).toContain('/api/runtime/launch');
  });

  it('ignores a retry response after the operator changes the restored repo scope', async () => {
    const newerRepoPath = '/tmp/newer-o8-instance/repo';
    window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, serializeTileLayout(persistedLayout(STALE_REPO_PATH)));
    const registeredRepos = [registeredRepo(STALE_REPO_PATH)];
    let validationCalls = 0;
    let completeRetry: ((response: Response) => void) | null = null;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.startsWith('/api/panel/repos')) return Promise.resolve(Response.json({}));
      validationCalls += 1;
      if (validationCalls === 1) return Promise.resolve(Response.json({}, { status: 503 }));
      return new Promise<Response>((resolve) => { completeRetry = resolve; });
    }));

    let latestLayout = createDefaultTileLayout();
    let replaceLayout: ((layout: TileLayout) => void) | null = null;
    const onLayout = (layout: TileLayout) => { latestLayout = layout; };
    await act(async () => root.render(createElement(LayoutRestoreHarness, {
      onLayout,
      onReplaceLayout: (replace) => { replaceLayout = replace; },
      registeredRepos,
    })));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)));

    const retryButton = container.querySelector<HTMLButtonElement>('button[aria-label="Retry saved repository scope"]');
    await act(async () => retryButton?.click());
    await act(async () => replaceLayout?.(persistedLayout(newerRepoPath)));
    await act(async () => {
      completeRetry?.(repoValidationResponse(`/api/panel/repos?restorePath=${encodeURIComponent(STALE_REPO_PATH)}`, registeredRepos));
      await Promise.resolve();
    });

    expect(validationCalls).toBe(2);
    expect(getFirstLeaf(latestLayout.root).content).toMatchObject({ repoPath: newerRepoPath });
  });

  it('ignores a completed repository refresh after the operator changes the restored repo scope', async () => {
    const newerRepoPath = '/tmp/newer-o8-instance/repo';
    window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, serializeTileLayout(persistedLayout(STALE_REPO_PATH)));
    const registeredRepos = [registeredRepo(STALE_REPO_PATH)];
    let validationCalls = 0;
    let completeRefresh: ((available: boolean) => void) | null = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.startsWith('/api/panel/repos')) return Response.json({});
      validationCalls += 1;
      return validationCalls === 1
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
    await act(async () => root.render(createElement(LayoutRestoreHarness, {
      onLayout,
      onReplaceLayout: (replace) => { replaceLayout = replace; },
      refreshRestoredRepoState,
      registeredRepos,
    })));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)));

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Retry saved repository scope"]')?.click());
    await act(async () => replaceLayout?.(persistedLayout(newerRepoPath)));
    await act(async () => {
      completeRefresh?.(true);
      await Promise.resolve();
    });

    expect(validationCalls).toBe(2);
    expect(validationState).toBe('idle');
    expect(getFirstLeaf(latestLayout.root).content).toMatchObject({ repoPath: newerRepoPath });
  });

  it('hydrates the newer layout safely when initial validation becomes stale', async () => {
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
    let validationState = 'idle';
    let replaceLayout: ((layout: TileLayout) => void) | null = null;
    const onLayout = (layout: TileLayout, nextHydrated: boolean, nextValidationState: string) => {
      latestLayout = layout;
      hydrated = nextHydrated;
      validationState = nextValidationState;
    };
    await act(async () => root.render(createElement(LayoutRestoreHarness, {
      onLayout,
      onReplaceLayout: (replace) => { replaceLayout = replace; },
      registeredRepos,
    })));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)));
    await act(async () => replaceLayout?.(persistedLayout(newerRepoPath)));
    await act(async () => {
      completeInitialValidation?.(repoValidationResponse(`/api/panel/repos?restorePath=${encodeURIComponent(STALE_REPO_PATH)}`, registeredRepos));
      await Promise.resolve();
    });

    expect(hydrated).toBe(true);
    expect(validationState).toBe('failed');
    expect(getFirstLeaf(latestLayout.root).content).toMatchObject({ repoPath: newerRepoPath });
    expect(runtimeLaunches).toEqual([]);
    expect(container.querySelector('button[aria-label="Retry saved repository scope"]')).not.toBeNull();
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
      await act(async () => vi.advanceTimersByTimeAsync(2100));

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
});
