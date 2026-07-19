import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Dispatch, SetStateAction } from 'react';
import type { TerminalTabHandle } from '@/components/desktop/workspace-terminal/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import {
  dispatchFocusRepoWorkspaceTab,
  FOCUS_REPO_WORKSPACE_TAB_EVENT,
} from '@/lib/desktop/events';
import { focusRepoWorkspace, handleRepoWorkspaceFocusEvent } from './focusRepoWorkspace';

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

function installTestWindow() {
  const target = new EventTarget();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: target,
  });
  return target;
}

function handleWithTabs(tabs: ReturnType<TerminalTabHandle['getTabsSnapshot']>['tabs']) {
  return {
    getTabsSnapshot: vi.fn(() => ({ tabs, activeTabId: tabs[0]?.id ?? '' })),
    focusTab: vi.fn(() => true),
    openOrchestratorTab: vi.fn(() => 'orchestrator-new'),
  } as unknown as TerminalTabHandle;
}

describe('focusRepoWorkspace', () => {
  it('focuses an existing repo-bound workspace tab', async () => {
    const handle = handleWithTabs([{
      id: 'repo-tab',
      label: 'o8 / Orchestrator',
      kind: 'orchestrator',
      repoPath: '/repos/o8/',
      lastActivity: 1,
    }]);
    const setActiveTileId = vi.fn();
    const setActiveWorkspace = vi.fn();
    const waitForWorkspaceTerminalTarget = vi.fn();

    await expect(focusRepoWorkspace({
      repo: { name: 'o8', localPath: '/repos/o8' },
      setActiveTileId,
      setActiveWorkspace,
      waitForWorkspaceTerminalTarget,
      workspaceTerminalHandlesRef: { current: new Map([['tile-existing', handle]]) },
    })).resolves.toEqual({ tileId: 'tile-existing', tabId: 'repo-tab', opened: false });

    expect(handle.focusTab).toHaveBeenCalledWith('repo-tab');
    expect(setActiveWorkspace).toHaveBeenCalledWith('/repos/o8');
    expect(setActiveTileId).toHaveBeenCalledWith('tile-existing');
    expect(waitForWorkspaceTerminalTarget).not.toHaveBeenCalled();
  });

  it('opens a repo-bound workspace tab when the repo has no binding', async () => {
    const handle = handleWithTabs([]);
    const setActiveTileId = vi.fn();
    const setActiveWorkspace = vi.fn();
    const waitForWorkspaceTerminalTarget = vi.fn().mockResolvedValue({ tileId: 'tile-new', handle });
    const repo = { name: 'o8', localPath: '/repos/o8', branch: 'main' };

    await expect(focusRepoWorkspace({
      repo,
      setActiveTileId,
      setActiveWorkspace,
      waitForWorkspaceTerminalTarget,
      workspaceTerminalHandlesRef: { current: new Map() },
    })).resolves.toEqual({ tileId: 'tile-new', tabId: 'orchestrator-new', opened: true });

    expect(waitForWorkspaceTerminalTarget).toHaveBeenCalledWith({ repoPath: '/repos/o8' });
    expect(setActiveWorkspace).toHaveBeenCalledWith('/repos/o8');
    expect(handle.openOrchestratorTab).toHaveBeenCalledWith(repo);
    expect(handle.focusTab).toHaveBeenCalledWith('orchestrator-new');
  });
});

function repoEntry(id: string, localPath: string): RepoRegistryEntry {
  return {
    id,
    name: localPath.split('/').filter(Boolean).pop() ?? localPath,
    localPath,
    remoteUrl: null,
    defaultBranch: 'main',
    addedAt: '2026-01-01T00:00:00.000Z',
    lastOpenedAt: null,
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

function installRealRepoFocusHandler(repoEntries: RepoRegistryEntry[]) {
  const target = installTestWindow();
  const handle = handleWithTabs([]);
  const handleAlignToRepo = vi.fn();
  const handleOpenO8Panel = vi.fn();
  const setActiveTileId = vi.fn();
  let activeWorkspace: string | undefined;
  const setActiveWorkspace: Dispatch<SetStateAction<string | undefined>> = vi.fn((value) => {
    activeWorkspace = typeof value === 'function' ? value(activeWorkspace) : value;
  });
  const waitForWorkspaceTerminalTarget = vi.fn().mockResolvedValue({ tileId: 'tile-project', handle });
  const flashWorkspaceTab = vi.fn();
  const reportSpawnFailure = vi.fn();
  const listener = (event: Event) => handleRepoWorkspaceFocusEvent(event, {
    repoEntries,
    handleAlignToRepo,
    handleOpenO8Panel,
    setActiveTileId,
    setActiveWorkspace,
    waitForWorkspaceTerminalTarget,
    workspaceTerminalHandlesRef: { current: new Map() },
    flashWorkspaceTab,
    reportSpawnFailure,
  });
  target.addEventListener(FOCUS_REPO_WORKSPACE_TAB_EVENT, listener);
  return {
    activeWorkspace: () => activeWorkspace,
    flashWorkspaceTab,
    handle,
    handleAlignToRepo,
    handleOpenO8Panel,
    reportSpawnFailure,
    waitForWorkspaceTerminalTarget,
  };
}

describe('project-tree repo workspace focus reachability', () => {
  it('claims an id-mismatched project repo by normalized path and opens its bound workspace', async () => {
    const harness = installRealRepoFocusHandler([
      repoEntry('global-repo-key', '/repos/o8/'),
    ]);

    expect(dispatchFocusRepoWorkspaceTab({
      repoId: 'project-tree-key',
      repoPath: '/repos/o8',
    })).toBe(true);
    expect(harness.activeWorkspace()).toBe('/repos/o8');
    expect(harness.handleAlignToRepo).toHaveBeenCalledWith('global-repo-key');
    expect(harness.handleOpenO8Panel).toHaveBeenCalledWith({ repoPath: '/repos/o8', tab: 'workspace' });

    await vi.waitFor(() => {
      expect(harness.handle.openOrchestratorTab).toHaveBeenCalledWith(expect.objectContaining({
        localPath: '/repos/o8',
        registryRepoId: 'global-repo-key',
      }));
      expect(harness.flashWorkspaceTab).toHaveBeenCalledWith('orchestrator-new');
    });
    expect(harness.reportSpawnFailure).not.toHaveBeenCalled();
  });

  it('claims an unregistered project path by deriving a repo and still opens its workspace', async () => {
    const harness = installRealRepoFocusHandler([]);

    expect(dispatchFocusRepoWorkspaceTab({
      repoId: 'project-only-key',
      repoPath: '/projects/only-in-tree/',
    })).toBe(true);
    expect(harness.activeWorkspace()).toBe('/projects/only-in-tree');
    expect(harness.handleAlignToRepo).not.toHaveBeenCalled();
    expect(harness.handleOpenO8Panel).toHaveBeenCalledWith({
      repoPath: '/projects/only-in-tree',
      tab: 'workspace',
    });

    await vi.waitFor(() => {
      expect(harness.handle.openOrchestratorTab).toHaveBeenCalledWith(expect.objectContaining({
        name: 'only-in-tree',
        localPath: '/projects/only-in-tree',
        registryRepoId: 'project-only-key',
      }));
    });
  });

  it('returns false so AgentPanel falls back when no handler claims the event', () => {
    installTestWindow();
    expect(dispatchFocusRepoWorkspaceTab({ repoPath: '/repos/unclaimed' })).toBe(false);
  });
});
