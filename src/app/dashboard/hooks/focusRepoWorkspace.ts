import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { RegisteredRepo, TerminalTabHandle } from '@/components/desktop/workspace-terminal/types';

interface WorkspaceTerminalTarget {
  tileId: string;
  handle: TerminalTabHandle;
}

interface FocusRepoWorkspaceArgs {
  repo: RegisteredRepo;
  setActiveTileId: Dispatch<SetStateAction<string | null>>;
  waitForWorkspaceTerminalTarget: (options?: { repoPath?: string | null }) => Promise<WorkspaceTerminalTarget>;
  workspaceTerminalHandlesRef: MutableRefObject<Map<string, TerminalTabHandle>>;
}

export interface FocusRepoWorkspaceResult {
  tileId: string;
  tabId: string;
  opened: boolean;
}

function normalizedPath(value: string | null | undefined): string {
  return value?.trim().replace(/\/+$/, '') ?? '';
}

function focusExistingRepoTab(
  repoPath: string,
  handles: Map<string, TerminalTabHandle>,
  setActiveTileId: Dispatch<SetStateAction<string | null>>,
): FocusRepoWorkspaceResult | null {
  const targetPath = normalizedPath(repoPath);
  for (const [tileId, handle] of handles.entries()) {
    const match = handle.getTabsSnapshot().tabs.find((tab) => normalizedPath(tab.repoPath) === targetPath);
    if (!match || !handle.focusTab(match.id)) continue;
    setActiveTileId(tileId);
    return { tileId, tabId: match.id, opened: false };
  }
  return null;
}

/**
 * Repo-row twin of #1480's packet focus seam: focus a bound workspace tab
 * first, then create a repo-bound Orchestrator tab only when none exists.
 */
export async function focusRepoWorkspace({
  repo,
  setActiveTileId,
  waitForWorkspaceTerminalTarget,
  workspaceTerminalHandlesRef,
}: FocusRepoWorkspaceArgs): Promise<FocusRepoWorkspaceResult> {
  const existing = focusExistingRepoTab(repo.localPath, workspaceTerminalHandlesRef.current, setActiveTileId);
  if (existing) return existing;

  const target = await waitForWorkspaceTerminalTarget({ repoPath: repo.localPath });
  const racedExisting = focusExistingRepoTab(
    repo.localPath,
    new Map([[target.tileId, target.handle]]),
    setActiveTileId,
  );
  if (racedExisting) return racedExisting;

  const tabId = target.handle.openOrchestratorTab(repo);
  setActiveTileId(target.tileId);
  target.handle.focusTab(tabId);
  return { tileId: target.tileId, tabId, opened: true };
}
