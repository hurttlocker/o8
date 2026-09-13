// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RepoRegistryEntry } from '@/lib/repos/types';

const mocks = vi.hoisted(() => ({
  fetchSWRJson: vi.fn(),
  ipcFetch: vi.fn(),
}));

vi.mock('@/lib/panel/fetch-cache', () => ({
  fetchSWRJson: mocks.fetchSWRJson,
  getSWR: () => ({ data: null }),
}));

vi.mock('@/lib/tauri/ipc-fetch', () => ({
  ipcFetch: mocks.ipcFetch,
}));

import { useGlobalRepoState } from './useGlobalRepoState';

type HookValue = ReturnType<typeof useGlobalRepoState>;

function repo(index: number): RepoRegistryEntry {
  const name = `repo-${String(index).padStart(4, '0')}`;
  return {
    id: name,
    name,
    localPath: `/tmp/${name}`,
    remoteUrl: null,
    defaultBranch: 'main',
    isGitRepo: true,
    addedAt: '2026-01-01T00:00:00.000Z',
    lastOpenedAt: null,
    storagePressureParkingDisabled: false,
    setup: {
      envMode: 'copy',
      envFiles: ['.env', '.env.local'],
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

function mountHook(onValue: (value: HookValue) => void): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  function Harness(): ReactElement {
    const value = useGlobalRepoState({
      activeWorkspace: undefined,
      setActiveNavSection: () => undefined,
      setSidebarVisible: () => undefined,
      sidebarVisible: true,
    });
    onValue(value);
    return createElement('div');
  }

  act(() => root.render(createElement(Harness)));
  return { host, root };
}

describe('global repository worktree discovery', () => {
  let mounted: { host: HTMLDivElement; root: Root } | null = null;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    window.sessionStorage.clear();
    mocks.fetchSWRJson.mockReset();
    mocks.ipcFetch.mockReset();
    mocks.ipcFetch.mockImplementation(async () => Response.json({
      worktrees: [],
      conflicts: { safe: true, count: 0 },
      totalDiskUsage: 0,
    }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/panel/branches?')) {
        return Response.json({ branches: [{ current: true, name: 'main' }] });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }));
  });

  afterEach(() => {
    if (mounted) act(() => mounted?.root.unmount());
    mounted = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
    document.body.replaceChildren();
  });

  it('loads only the selected repository on fleet mount and targets other repos on demand', async () => {
    const repos = Array.from({ length: 250 }, (_, index) => repo(index + 1));
    mocks.fetchSWRJson.mockResolvedValue({ repos });
    let current: HookValue | null = null;
    mounted = mountHook((value) => { current = value; });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(mocks.ipcFetch).toHaveBeenCalledTimes(1);
    expect(mocks.ipcFetch).toHaveBeenLastCalledWith('/api/worktrees?repo=%2Ftmp%2Frepo-0001');

    await act(async () => {
      await current?.loadRepoWorktrees('/tmp/repo-0250');
    });

    expect(mocks.ipcFetch).toHaveBeenCalledTimes(2);
    expect(mocks.ipcFetch).toHaveBeenLastCalledWith('/api/worktrees?repo=%2Ftmp%2Frepo-0250');
  });

  it('rebuilds an exact saved worktree scope from the authoritative repo producer', async () => {
    const registered = repo(1);
    const externalOwner = repo(2);
    const worktreePath = '/tmp/o8-external-worktrees/saved-chat';
    mocks.fetchSWRJson.mockRejectedValue(new Error('cold-start repository list failed'));
    mocks.ipcFetch.mockImplementation(async (input: string) => {
      if (input === '/api/panel/repos') return Response.json({ repos: [registered, externalOwner] });
      if (input === `/api/worktrees?repo=${encodeURIComponent(registered.localPath)}`) {
        return Response.json({ worktrees: [], conflicts: { safe: true, count: 0 }, totalDiskUsage: 0 });
      }
      if (input === `/api/worktrees?repo=${encodeURIComponent(externalOwner.localPath)}`) {
        return Response.json({
          worktrees: [{ path: worktreePath, branch: 'saved-chat', status: 'active' }],
          conflicts: { safe: true, count: 0 },
          totalDiskUsage: 0,
        });
      }
      throw new Error(`Unexpected IPC fetch: ${input}`);
    });
    let current = undefined as unknown as HookValue;
    mounted = mountHook((value) => { current = value; });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(current.globalRepoEntries).toEqual([]);

    let refreshed = false;
    await act(async () => {
      refreshed = await current.refreshRestoredRepoState([worktreePath]);
    });

    expect(refreshed).toBe(true);
    expect(current.globalRepoEntries).toEqual([registered, externalOwner]);
    expect(current.workspaceScopeEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ localPath: registered.localPath }),
      expect.objectContaining({ localPath: externalOwner.localPath }),
      expect.objectContaining({ localPath: worktreePath, isWorktree: true }),
    ]));
  });

  it('does not authorize a validated worktree when its producer cannot return that scope', async () => {
    const registered = repo(1);
    mocks.fetchSWRJson.mockResolvedValue({ repos: [] });
    mocks.ipcFetch.mockImplementation(async (input: string) => {
      if (input === '/api/panel/repos') return Response.json({ repos: [registered] });
      if (input.startsWith('/api/worktrees?repo=')) {
        return Response.json({ worktrees: [], conflicts: { safe: true, count: 0 }, totalDiskUsage: 0 });
      }
      throw new Error(`Unexpected IPC fetch: ${input}`);
    });
    let current = undefined as unknown as HookValue;
    mounted = mountHook((value) => { current = value; });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await expect(current.refreshRestoredRepoState(['/tmp/o8-external-worktrees/missing'])).resolves.toBe(false);
    expect(current.globalRepoEntries).toEqual([]);
  });

  it('bounds and abandons a hung authoritative restore refresh', async () => {
    mocks.fetchSWRJson.mockResolvedValue({ repos: [] });
    mocks.ipcFetch.mockImplementation(() => new Promise<Response>(() => undefined));
    let current = undefined as unknown as HookValue;
    mounted = mountHook((value) => { current = value; });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    let refreshed = true;
    await act(async () => {
      const pending = current.refreshRestoredRepoState(['/tmp/o8-external-worktrees/saved-chat']);
      await vi.advanceTimersByTimeAsync(2_000);
      refreshed = await pending;
    });

    expect(refreshed).toBe(false);
    expect(current.globalRepoEntries).toEqual([]);
  });

  it('ignores a stale repository inventory after its recovery signal is cancelled', async () => {
    const registered = repo(1);
    let resolveRepos: ((response: Response) => void) | null = null;
    mocks.fetchSWRJson.mockResolvedValue({ repos: [] });
    mocks.ipcFetch.mockImplementation((input: string) => {
      if (input === '/api/panel/repos') return new Promise<Response>((resolve) => { resolveRepos = resolve; });
      throw new Error(`Unexpected IPC fetch: ${input}`);
    });
    let current = undefined as unknown as HookValue;
    mounted = mountHook((value) => { current = value; });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = new AbortController();
    const pending = current.refreshRestoredRepoState([registered.localPath], controller.signal);
    controller.abort();
    await act(async () => {
      resolveRepos?.(Response.json({ repos: [registered] }));
      await expect(pending).resolves.toBe(false);
    });

    expect(current.globalRepoEntries).toEqual([]);
  });
});
