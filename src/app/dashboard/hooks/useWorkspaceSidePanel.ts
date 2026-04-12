import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceSidePanelRepo, WorkspaceSidePanelView } from '@/components/desktop/WorkspaceSidePanel';
import type { WorkspaceLaneState } from '@/lib/orchestrator/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { WorkspaceScopeEntry } from '../types';
import { repoSlugFromRemote, sameWorkspaceSidePanelRepo } from '../utils';

interface UseWorkspaceSidePanelArgs {
  activeSurfaceRepoPath: string | null;
  activeWorkspaceLane: WorkspaceLaneState | null;
  globalRepoBranch: string;
  globalRepoEntries: RepoRegistryEntry[];
  globalRepoEntry: RepoRegistryEntry | null;
  workspaceScopeEntries: WorkspaceScopeEntry[];
  workspaceTerminalPreferredRepo: WorkspaceSidePanelRepo | null;
}

export function useWorkspaceSidePanel({
  activeSurfaceRepoPath,
  activeWorkspaceLane,
  globalRepoBranch,
  globalRepoEntries,
  globalRepoEntry,
  workspaceScopeEntries,
  workspaceTerminalPreferredRepo,
}: UseWorkspaceSidePanelArgs) {
  const [chatVisible, setChatVisible] = useState(true);
  const rightPanelMode = 'workspace' as const;
  const setRightPanelMode = (_mode: 'chat' | 'workspace') => { /* v1: right panel is always workspace */ };
  const [workspaceSidePanelView, setWorkspaceSidePanelView] = useState<WorkspaceSidePanelView>('diff');
  const [workspaceSidePanelRepoPath, setWorkspaceSidePanelRepoPath] = useState<string | null>(null);
  const [workspaceSidePanelRepoContext, setWorkspaceSidePanelRepoContext] = useState<WorkspaceSidePanelRepo | null>(null);
  const [workspaceSidePanelActivationKey, setWorkspaceSidePanelActivationKey] = useState(0);
  const lastWorkspacePanelViewRef = useRef<'diff'>('diff');

  const workspaceSidePanelRepo = useMemo<WorkspaceSidePanelRepo | null>(() => {
    if (
      workspaceSidePanelRepoContext
      && (!workspaceSidePanelRepoPath || workspaceSidePanelRepoContext.localPath === workspaceSidePanelRepoPath)
    ) {
      return workspaceSidePanelRepoContext;
    }
    if (!workspaceSidePanelRepoPath) {
      return null;
    }
    const matched = workspaceScopeEntries.find((repo) => repo.localPath === workspaceSidePanelRepoPath) ?? null;
    if (!matched) {
      return globalRepoEntry?.localPath === workspaceSidePanelRepoPath
        ? {
            name: globalRepoEntry.name,
            localPath: globalRepoEntry.localPath,
            branch: globalRepoEntry.readiness?.currentBranch ?? globalRepoBranch,
            readiness: globalRepoEntry.readiness ?? null,
            remoteUrl: globalRepoEntry.remoteUrl ?? undefined,
          }
        : null;
    }
    return {
      name: matched.name,
      localPath: matched.localPath,
      branch: matched.branch ?? matched.readiness?.currentBranch ?? null,
      readiness: matched.readiness ?? null,
      remoteUrl: matched.remoteUrl ?? undefined,
      isWorktree: matched.isWorktree ?? undefined,
      worktreeStatus: matched.worktreeStatus ?? undefined,
    };
  }, [globalRepoBranch, globalRepoEntry, workspaceScopeEntries, workspaceSidePanelRepoContext, workspaceSidePanelRepoPath]);
  const getWorkspaceSidePanelRepoBySlug = useCallback((repoSlug?: string | null): WorkspaceSidePanelRepo | null => {
    if (!repoSlug) return globalRepoEntry ? {
      name: globalRepoEntry.name,
      localPath: globalRepoEntry.localPath,
      branch: globalRepoEntry.readiness?.currentBranch ?? globalRepoBranch,
      readiness: globalRepoEntry.readiness ?? null,
      remoteUrl: globalRepoEntry.remoteUrl ?? undefined,
    } : null;

    const matched = globalRepoEntries.find((entry) => repoSlugFromRemote(entry.remoteUrl) === repoSlug) ?? null;
    if (!matched) return null;
    return {
      name: matched.name,
      localPath: matched.localPath,
      branch: matched.readiness?.currentBranch ?? matched.defaultBranch,
      readiness: matched.readiness ?? null,
      remoteUrl: matched.remoteUrl ?? undefined,
    };
  }, [globalRepoBranch, globalRepoEntries, globalRepoEntry]);
  const getWorkspaceSidePanelRepoByPath = useCallback((repoPath?: string | null): WorkspaceSidePanelRepo | null => {
    if (!repoPath) {
      return globalRepoEntry ? {
        name: globalRepoEntry.name,
        localPath: globalRepoEntry.localPath,
        branch: globalRepoEntry.readiness?.currentBranch ?? globalRepoBranch,
        readiness: globalRepoEntry.readiness ?? null,
        remoteUrl: globalRepoEntry.remoteUrl ?? undefined,
      } : null;
    }

    const matched = workspaceScopeEntries.find((entry) => entry.localPath === repoPath) ?? null;
    if (!matched) return null;
    return {
      name: matched.name,
      localPath: matched.localPath,
      branch: matched.branch ?? matched.readiness?.currentBranch ?? null,
      readiness: matched.readiness ?? null,
      remoteUrl: matched.remoteUrl ?? undefined,
    };
  }, [globalRepoBranch, globalRepoEntry, workspaceScopeEntries]);
  const openWorkspaceSidePanel = useCallback((
    view: WorkspaceSidePanelView,
    repo?: WorkspaceSidePanelRepo | null,
  ) => {
    setChatVisible(true);
    setRightPanelMode('workspace');
    setWorkspaceSidePanelView(view);
    setWorkspaceSidePanelRepoPath(repo?.localPath ?? globalRepoEntry?.localPath ?? null);
    setWorkspaceSidePanelRepoContext(repo ?? (globalRepoEntry ? {
      name: globalRepoEntry.name,
      localPath: globalRepoEntry.localPath,
      branch: globalRepoEntry.readiness?.currentBranch ?? globalRepoBranch,
      readiness: globalRepoEntry.readiness ?? null,
      remoteUrl: globalRepoEntry.remoteUrl ?? undefined,
    } : null));
    setWorkspaceSidePanelActivationKey((value) => value + 1);
  }, [globalRepoBranch, globalRepoEntry]);

  useEffect(() => {
    if (workspaceSidePanelView === 'diff') {
      lastWorkspacePanelViewRef.current = workspaceSidePanelView;
    }
  }, [workspaceSidePanelView]);

  const handleToggleChatPanel = useCallback(() => {
    // v1: chat panel removed — toggle workspace instead
    if (chatVisible) {
      setChatVisible(false);
      return;
    }
    setChatVisible(true);
  }, [chatVisible]);

  const handleToggleWorkspacePanel = useCallback(() => {
    if (chatVisible && rightPanelMode === 'workspace') {
      setChatVisible(false);
      return;
    }
    const nextView = workspaceSidePanelView === 'diff' ? 'diff' : lastWorkspacePanelViewRef.current;
    openWorkspaceSidePanel(nextView, workspaceSidePanelRepo);
  }, [chatVisible, openWorkspaceSidePanel, rightPanelMode, workspaceSidePanelRepo, workspaceSidePanelView]);

  useEffect(() => {
    if (rightPanelMode !== 'workspace') return;
    // [workspace-side-panel] Skip auto-sync when panel is in blank/idle state —
    // repo context will be set explicitly when a view is opened via openWorkspaceSidePanel.
    if (workspaceSidePanelView === 'blank') return;

    // Lane-scoped context: when the active lane has branch info, use it
    // so the review rail shows the selected lane's diff, not main's.
    let nextRepoContext: WorkspaceSidePanelRepo | null = null;
    if (activeWorkspaceLane?.repoPath && activeWorkspaceLane.branch) {
      const laneName = activeWorkspaceLane.repoPath.split('/').pop() ?? 'repo';
      nextRepoContext = {
        name: laneName,
        localPath: activeWorkspaceLane.repoPath,
        branch: activeWorkspaceLane.branch,
        readiness: null,
        isWorktree: activeWorkspaceLane.branch !== 'main',
      };
    }

    // Fall through to terminal/global when no lane branch context
    if (!nextRepoContext) {
      nextRepoContext = workspaceTerminalPreferredRepo
        ?? (globalRepoEntry ? {
          name: globalRepoEntry.name,
          localPath: globalRepoEntry.localPath,
          branch: globalRepoEntry.readiness?.currentBranch ?? globalRepoBranch,
          readiness: globalRepoEntry.readiness ?? null,
          remoteUrl: globalRepoEntry.remoteUrl ?? undefined,
        } : null);
    }

    const nextRepoPath = nextRepoContext?.localPath
      ?? activeSurfaceRepoPath
      ?? workspaceTerminalPreferredRepo?.localPath
      ?? globalRepoEntry?.localPath
      ?? null;
    if (workspaceSidePanelRepoPath === nextRepoPath && sameWorkspaceSidePanelRepo(workspaceSidePanelRepoContext, nextRepoContext)) {
      return;
    }
    setWorkspaceSidePanelRepoPath(nextRepoPath);
    setWorkspaceSidePanelRepoContext(nextRepoContext);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- repoContext/repoPath are outputs, not inputs; including them creates a feedback loop
  }, [
    activeSurfaceRepoPath,
    activeWorkspaceLane?.branch,
    activeWorkspaceLane?.repoPath,
    globalRepoBranch,
    globalRepoEntry,
    rightPanelMode,
    workspaceSidePanelView,
    workspaceTerminalPreferredRepo?.localPath,
  ]);

  return {
    chatVisible,
    getWorkspaceSidePanelRepoByPath,
    getWorkspaceSidePanelRepoBySlug,
    handleToggleChatPanel,
    handleToggleWorkspacePanel,
    openWorkspaceSidePanel,
    rightPanelMode,
    setChatVisible,
    setRightPanelMode,
    setWorkspaceSidePanelActivationKey,
    setWorkspaceSidePanelRepoContext,
    setWorkspaceSidePanelRepoPath,
    setWorkspaceSidePanelView,
    workspaceSidePanelActivationKey,
    workspaceSidePanelRepo,
    workspaceSidePanelRepoContext,
    workspaceSidePanelRepoPath,
    workspaceSidePanelView,
  };
}
