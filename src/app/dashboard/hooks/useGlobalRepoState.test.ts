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
});
