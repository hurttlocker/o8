import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { RegisteredRepo, TerminalTabHandle } from '@/components/desktop/workspace-terminal/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { FocusRepoWorkspaceTabDetail } from '@/lib/desktop/events';

interface WorkspaceTerminalTarget {
  tileId: string;
  handle: TerminalTabHandle;
}

interface FocusRepoWorkspaceArgs {
  repo: RegisteredRepo;
  setActiveTileId: Dispatch<SetStateAction<string | null>>;
  setActiveWorkspace: Dispatch<SetStateAction<string | undefined>>;
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

function repoNameFromPath(repoPath: string): string {
  return repoPath.split('/').filter(Boolean).pop() ?? repoPath;
}

export interface ResolvedRepoWorkspaceFocus {
  repo: RegisteredRepo;
  alignmentRepoId: string | null;
}

export function resolveRepoWorkspaceFocus(
  detail: FocusRepoWorkspaceTabDetail | null | undefined,
  repoEntries: RepoRegistryEntry[],
): ResolvedRepoWorkspaceFocus | null {
  const repoId = detail?.repoId?.trim() ?? '';
  const repoPath = normalizedPath(detail?.repoPath);
  const entry = (repoPath
    ? repoEntries.find((candidate) => normalizedPath(candidate.localPath) === repoPath)
    : null)
    ?? (repoId ? repoEntries.find((candidate) => candidate.id === repoId) : null)
    ?? null;

  if (entry) {
    return {
      alignmentRepoId: entry.id,
      repo: {
        name: entry.name,
        localPath: normalizedPath(entry.localPath),
        remoteUrl: entry.remoteUrl ?? undefined,
        branch: entry.readiness?.currentBranch ?? entry.defaultBranch,
        readiness: entry.readiness ?? null,
        registryRepoId: entry.id,
      },
    };
  }

  if (!repoPath) return null;
  return {
    alignmentRepoId: null,
    repo: {
      name: repoNameFromPath(repoPath),
      localPath: repoPath,
      registryRepoId: repoId || undefined,
    },
  };
}

interface HandleRepoWorkspaceFocusEventArgs {
  repoEntries: RepoRegistryEntry[];
  handleAlignToRepo: (repoId: string) => void;
  handleOpenO8Panel: (options: { repoPath?: string | null; tab?: 'workspace' }) => void;
  setActiveTileId: Dispatch<SetStateAction<string | null>>;
  setActiveWorkspace: Dispatch<SetStateAction<string | undefined>>;
  waitForWorkspaceTerminalTarget: (options?: { repoPath?: string | null }) => Promise<WorkspaceTerminalTarget>;
  workspaceTerminalHandlesRef: MutableRefObject<Map<string, TerminalTabHandle>>;
  flashWorkspaceTab: (tabId: string) => void;
  reportSpawnFailure: (kind: string, error: unknown) => void;
}

export function handleRepoWorkspaceFocusEvent(
  event: Event,
  args: HandleRepoWorkspaceFocusEventArgs,
): void {
  const detail = (event as CustomEvent<FocusRepoWorkspaceTabDetail>).detail;
  const resolved = resolveRepoWorkspaceFocus(detail, args.repoEntries);
  if (!resolved) return;

  try {
    if (resolved.alignmentRepoId) args.handleAlignToRepo(resolved.alignmentRepoId);
    args.handleOpenO8Panel({ repoPath: resolved.repo.localPath, tab: 'workspace' });
    const focused = focusRepoWorkspace({
      repo: resolved.repo,
      setActiveTileId: args.setActiveTileId,
      setActiveWorkspace: args.setActiveWorkspace,
      waitForWorkspaceTerminalTarget: args.waitForWorkspaceTerminalTarget,
      workspaceTerminalHandlesRef: args.workspaceTerminalHandlesRef,
    });
    event.preventDefault();
    void focused.then(({ tabId }) => {
      args.flashWorkspaceTab(tabId);
    }).catch((error) => {
      args.reportSpawnFailure('repo workspace', error);
    });
  } catch (error) {
    args.reportSpawnFailure('repo workspace', error);
  }
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
  setActiveWorkspace,
  waitForWorkspaceTerminalTarget,
  workspaceTerminalHandlesRef,
}: FocusRepoWorkspaceArgs): Promise<FocusRepoWorkspaceResult> {
  setActiveWorkspace(repo.localPath);
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
