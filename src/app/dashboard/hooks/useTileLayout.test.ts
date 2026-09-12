// @vitest-environment jsdom

import { act, createElement, useEffect, useRef, useState } from 'react';
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
  registeredRepos,
}: {
  onLayout: (layout: TileLayout, hydrated: boolean) => void;
  registeredRepos: RepoRegistryEntry[];
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
    onLayout(layout, restored.tileLayoutHydrated);
  }, [layout, onLayout, restored.tileLayoutHydrated]);

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
