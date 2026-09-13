// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RepoRegistryEntry } from '@/lib/repos/types';

const mocks = vi.hoisted(() => ({
  fetchSWRJson: vi.fn(),
  ipcFetch: vi.fn(),
  requestConfirm: vi.fn(async () => true),
}));

vi.mock('@/lib/panel/fetch-cache', () => ({
  fetchSWRJson: mocks.fetchSWRJson,
  getSWR: () => ({ data: null }),
}));

vi.mock('@/lib/tauri/ipc-fetch', () => ({
  ipcFetch: mocks.ipcFetch,
}));

vi.mock('@/components/shared/ConfirmToastHost', () => ({
  requestConfirm: mocks.requestConfirm,
  requestPrompt: vi.fn(async () => null),
  toast: vi.fn(),
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

  it('keeps recovered inventory when the older mount request rejects later', async () => {
    const registered = repo(1);
    let rejectMount: (error: Error) => void = () => { throw new Error('Mount request not started'); };
    mocks.fetchSWRJson.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectMount = reject;
    }));
    mocks.ipcFetch.mockImplementation(async (input: string) => {
      if (input === '/api/panel/repos') return Response.json({ repos: [registered] });
      return Response.json({ worktrees: [], conflicts: { safe: true, count: 0 }, totalDiskUsage: 0 });
    });
    let current = undefined as unknown as HookValue;
    mounted = mountHook((value) => { current = value; });

    await act(async () => {
      expect(await current.refreshRestoredRepoState([registered.localPath])).toBe(true);
    });
    expect(current.globalRepoEntries).toEqual([registered]);

    await act(async () => {
      rejectMount(new Error('Old startup request failed'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(current.globalRepoEntries).toEqual([registered]);
    expect(current.workspaceScopeEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ localPath: registered.localPath }),
    ]));
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

  it('lets a newer repos-changed inventory win over a recovery refresh still fanning out worktrees', async () => {
    const savedRepo = repo(1);
    const otherRepo = repo(2);
    const worktreePath = '/tmp/o8-external-worktrees/saved-chat';
    let resolveSavedWorktrees: ((response: Response) => void) | null = null;
    mocks.fetchSWRJson.mockImplementation(async () => ({ repos: [otherRepo] }));
    mocks.ipcFetch.mockImplementation((input: string) => {
      if (input === '/api/panel/repos') return Promise.resolve(Response.json({ repos: [savedRepo, otherRepo] }));
      if (input === `/api/worktrees?repo=${encodeURIComponent(savedRepo.localPath)}`) {
        return new Promise<Response>((resolve) => { resolveSavedWorktrees = resolve; });
      }
      if (input === `/api/worktrees?repo=${encodeURIComponent(otherRepo.localPath)}`) {
        return Promise.resolve(Response.json({ worktrees: [], conflicts: { safe: true, count: 0 }, totalDiskUsage: 0 }));
      }
      throw new Error(`Unexpected IPC fetch: ${input}`);
    });
    let current = undefined as unknown as HookValue;
    mounted = mountHook((value) => { current = value; });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Recovery starts fanning out worktree lookups for BOTH repos (savedRepo
    // is still pending)...
    const recoveryPending = current.refreshRestoredRepoState([worktreePath]);
    await act(async () => { await Promise.resolve(); });

    // ...then the operator removes savedRepo entirely (an o8:repos-changed
    // style authoritative reload) WHILE that recovery is still in flight.
    await act(async () => { await current.loadRegisteredRepos(); });
    expect(current.globalRepoEntries).toEqual([otherRepo]);

    // The stale recovery finally finishes its (now-irrelevant) worktree
    // lookup and must NOT resurrect the removed repo.
    let refreshed = true;
    await act(async () => {
      resolveSavedWorktrees?.(Response.json({
        worktrees: [{ path: worktreePath, branch: 'saved-chat', status: 'active' }],
        conflicts: { safe: true, count: 0 },
        totalDiskUsage: 0,
      }));
      refreshed = await recoveryPending;
    });

    expect(refreshed).toBe(false);
    expect(current.globalRepoEntries).toEqual([otherRepo]);
  });

  it('tolerates one unrelated repo worktree lookup failing while still authorizing another repo saved worktree', async () => {
    const brokenRepo = repo(1);
    const owningRepo = repo(2);
    const worktreePath = '/tmp/o8-external-worktrees/saved-chat';
    mocks.fetchSWRJson.mockResolvedValue({ repos: [] });
    mocks.ipcFetch.mockImplementation(async (input: string) => {
      if (input === '/api/panel/repos') return Response.json({ repos: [brokenRepo, owningRepo] });
      if (input === `/api/worktrees?repo=${encodeURIComponent(brokenRepo.localPath)}`) {
        return Response.json({ error: 'boom' }, { status: 500 });
      }
      if (input === `/api/worktrees?repo=${encodeURIComponent(owningRepo.localPath)}`) {
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

    let refreshed = false;
    await act(async () => {
      refreshed = await current.refreshRestoredRepoState([worktreePath]);
    });

    expect(refreshed).toBe(true);
    expect(current.globalRepoEntries).toEqual([brokenRepo, owningRepo]);
    expect(current.workspaceScopeEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ localPath: worktreePath, isWorktree: true }),
    ]));
  });

  it('keeps a repo absent after a confirmed Remove even when a stale recovery refresh resolves later', async () => {
    const removedRepo = repo(1);
    const otherRepo = repo(2);
    const worktreePath = '/tmp/o8-external-worktrees/saved-chat';
    let resolveRemovedRepoWorktrees: ((response: Response) => void) | null = null;
    mocks.fetchSWRJson.mockResolvedValue({ repos: [removedRepo, otherRepo] });
    mocks.ipcFetch.mockImplementation((input: string) => {
      if (input === '/api/panel/repos') return Promise.resolve(Response.json({ repos: [removedRepo, otherRepo] }));
      if (input === `/api/worktrees?repo=${encodeURIComponent(removedRepo.localPath)}`) {
        return new Promise<Response>((resolve) => { resolveRemovedRepoWorktrees = resolve; });
      }
      if (input === `/api/worktrees?repo=${encodeURIComponent(otherRepo.localPath)}`) {
        return Promise.resolve(Response.json({ worktrees: [], conflicts: { safe: true, count: 0 }, totalDiskUsage: 0 }));
      }
      throw new Error(`Unexpected IPC fetch: ${input}`);
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/panel/branches?')) return Response.json({ branches: [{ current: true, name: 'main' }] });
      if (url === '/api/panel/repos' && init?.method === 'DELETE') return Response.json({ ok: true });
      throw new Error(`Unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
    }));

    let current = undefined as unknown as HookValue;
    mounted = mountHook((value) => { current = value; });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(current.globalRepoEntries).toEqual([removedRepo, otherRepo]);

    // Recovery starts fanning out worktree lookups for both repos —
    // removedRepo's is still pending.
    const recoveryPending = current.refreshRestoredRepoState([worktreePath]);
    await act(async () => { await Promise.resolve(); });

    // The operator confirms Remove on removedRepo through the REAL
    // exported handler (real confirm + real DELETE) WHILE that recovery is
    // still waiting on removedRepo's own worktree lookup.
    await act(async () => { await current.handleRemoveRegisteredRepo(removedRepo.id); });
    expect(mocks.requestConfirm).toHaveBeenCalled();
    expect(current.globalRepoEntries).toEqual([otherRepo]);

    // The stale recovery's (now-irrelevant) worktree lookup finally
    // resolves and would, on the pre-fix code, resurrect removedRepo.
    let refreshed = true;
    await act(async () => {
      resolveRemovedRepoWorktrees?.(Response.json({
        worktrees: [{ path: worktreePath, branch: 'saved-chat', status: 'active' }],
        conflicts: { safe: true, count: 0 },
        totalDiskUsage: 0,
      }));
      refreshed = await recoveryPending;
    });

    expect(refreshed).toBe(false);
    expect(current.globalRepoEntries).toEqual([otherRepo]);
  });

  it('preserves a newer confirmed touch after a stale recovery refresh resolves later', async () => {
    const touchedRepo = repo(1);
    const otherRepo = repo(2);
    const worktreePath = '/tmp/o8-external-worktrees/saved-chat';
    const touchedRepoAfterTouch: RepoRegistryEntry = { ...touchedRepo, lastOpenedAt: '2026-09-14T00:00:00.000Z' };
    let resolveOtherWorktrees: ((response: Response) => void) | null = null;
    mocks.fetchSWRJson.mockResolvedValue({ repos: [touchedRepo, otherRepo] });
    mocks.ipcFetch.mockImplementation((input: string) => {
      if (input === '/api/panel/repos') return Promise.resolve(Response.json({ repos: [touchedRepo, otherRepo] }));
      if (input === `/api/worktrees?repo=${encodeURIComponent(touchedRepo.localPath)}`) {
        return Promise.resolve(Response.json({
          worktrees: [{ path: worktreePath, branch: 'saved-chat', status: 'active' }],
          conflicts: { safe: true, count: 0 },
          totalDiskUsage: 0,
        }));
      }
      if (input === `/api/worktrees?repo=${encodeURIComponent(otherRepo.localPath)}`) {
        return new Promise<Response>((resolve) => { resolveOtherWorktrees = resolve; });
      }
      throw new Error(`Unexpected IPC fetch: ${input}`);
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/panel/branches?')) return Response.json({ branches: [{ current: true, name: 'main' }] });
      if (url === '/api/panel/repos' && init?.method === 'POST') return Response.json({ repo: touchedRepoAfterTouch });
      throw new Error(`Unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
    }));

    let current = undefined as unknown as HookValue;
    mounted = mountHook((value) => { current = value; });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Recovery starts fanning out; otherRepo's worktree lookup stays
    // pending so the whole refresh is still in flight for the next step.
    const recoveryPending = current.refreshRestoredRepoState([worktreePath]);
    await act(async () => { await Promise.resolve(); });

    // The operator selects touchedRepo through the REAL exported handler
    // (fires the real 'touch' POST) WHILE that recovery is still in flight.
    await act(async () => {
      await current.handleSelectRegisteredRepo(touchedRepo.id);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(current.globalRepoEntries.find((entry) => entry.id === touchedRepo.id)).toEqual(touchedRepoAfterTouch);

    // The stale recovery's worktree lookup finally resolves and would, on
    // the pre-fix code, overwrite the touched record with its pre-touch
    // snapshot.
    let refreshed = true;
    await act(async () => {
      resolveOtherWorktrees?.(Response.json({ worktrees: [], conflicts: { safe: true, count: 0 }, totalDiskUsage: 0 }));
      refreshed = await recoveryPending;
    });

    expect(refreshed).toBe(false);
    expect(current.globalRepoEntries.find((entry) => entry.id === touchedRepo.id)).toEqual(touchedRepoAfterTouch);
  });
});
