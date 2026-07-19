import { describe, expect, it, vi } from 'vitest';
import type { TerminalTabHandle } from '@/components/desktop/workspace-terminal/types';
import { focusRepoWorkspace } from './focusRepoWorkspace';

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
    const waitForWorkspaceTerminalTarget = vi.fn();

    await expect(focusRepoWorkspace({
      repo: { name: 'o8', localPath: '/repos/o8' },
      setActiveTileId,
      waitForWorkspaceTerminalTarget,
      workspaceTerminalHandlesRef: { current: new Map([['tile-existing', handle]]) },
    })).resolves.toEqual({ tileId: 'tile-existing', tabId: 'repo-tab', opened: false });

    expect(handle.focusTab).toHaveBeenCalledWith('repo-tab');
    expect(setActiveTileId).toHaveBeenCalledWith('tile-existing');
    expect(waitForWorkspaceTerminalTarget).not.toHaveBeenCalled();
  });

  it('opens a repo-bound workspace tab when the repo has no binding', async () => {
    const handle = handleWithTabs([]);
    const setActiveTileId = vi.fn();
    const waitForWorkspaceTerminalTarget = vi.fn().mockResolvedValue({ tileId: 'tile-new', handle });
    const repo = { name: 'o8', localPath: '/repos/o8', branch: 'main' };

    await expect(focusRepoWorkspace({
      repo,
      setActiveTileId,
      waitForWorkspaceTerminalTarget,
      workspaceTerminalHandlesRef: { current: new Map() },
    })).resolves.toEqual({ tileId: 'tile-new', tabId: 'orchestrator-new', opened: true });

    expect(waitForWorkspaceTerminalTarget).toHaveBeenCalledWith({ repoPath: '/repos/o8' });
    expect(handle.openOrchestratorTab).toHaveBeenCalledWith(repo);
    expect(handle.focusTab).toHaveBeenCalledWith('orchestrator-new');
  });
});
