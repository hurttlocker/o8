import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceLifecycleRecordView, WorkspaceLifecycleSummaryView } from '@/lib/workspace/lifecycle-types';
import type {
  UseWorkspaceLifecycleArgs,
  UseWorkspaceLifecycleResult,
  WorkspaceLifecycleMutationAction,
} from '../types';

export function useWorkspaceLifecycle({
  currentReviewAgent,
  globalRepoPath,
  scopedRepoAgents,
  selectedSessionAgent,
  workspaceTerminalPreferredRepoPath,
  wsStatus,
}: UseWorkspaceLifecycleArgs): UseWorkspaceLifecycleResult {
  const [workspaceLifecycleRecords, setWorkspaceLifecycleRecords] = useState<WorkspaceLifecycleRecordView[]>([]);
  const [workspaceLifecycleSummary, setWorkspaceLifecycleSummary] = useState<WorkspaceLifecycleSummaryView>({
    unreadCount: 0,
    archivedCount: 0,
    nextAttentionWorkspaceId: null,
  });
  const lastMarkedWorkspaceReadRef = useRef<string>('');

  const refreshWorkspaceLifecycle = useCallback(async () => {
    try {
      const response = await fetch('/api/panel/workspaces', {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      });
      if (!response.ok) return;
      const payload = await response.json() as {
        lifecycle?: {
          records?: WorkspaceLifecycleRecordView[];
          summary?: WorkspaceLifecycleSummaryView;
        };
      };
      setWorkspaceLifecycleRecords(payload.lifecycle?.records ?? []);
      setWorkspaceLifecycleSummary(payload.lifecycle?.summary ?? {
        unreadCount: 0,
        archivedCount: 0,
        nextAttentionWorkspaceId: null,
      });
    } catch {
      // Keep the last truthful lifecycle snapshot if refresh fails.
    }
  }, []);

  const mutateWorkspaceLifecycle = useCallback(async (
    action: WorkspaceLifecycleMutationAction,
    workspaceId: string,
  ) => {
    const response = await fetch('/api/panel/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, workspaceId }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error || 'Unable to update workspace lifecycle.');
    }
    await refreshWorkspaceLifecycle();
  }, [refreshWorkspaceLifecycle]);

  useEffect(() => {
    const initTimer = setTimeout(() => { void refreshWorkspaceLifecycle(); }, 2_500);
    const intervalId = window.setInterval(() => {
      void refreshWorkspaceLifecycle();
    }, 30_000);
    return () => { clearTimeout(initTimer); window.clearInterval(intervalId); };
  }, [refreshWorkspaceLifecycle]);

  /* eslint-disable react-hooks/set-state-in-effect -- preserve the existing refresh-on-connect behavior without changing logic */
  useEffect(() => {
    if (wsStatus !== 'connected') return;
    void refreshWorkspaceLifecycle();
  }, [refreshWorkspaceLifecycle, wsStatus]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const currentWorkspaceLifecycleRecord = useMemo(() => {
    const workflowAgent = currentReviewAgent ?? selectedSessionAgent ?? scopedRepoAgents[0] ?? null;
    if (workflowAgent?.sessionKey) {
      const liveMatch = workspaceLifecycleRecords.find((record) => (
        record.live && record.sessionKey === workflowAgent.sessionKey
      ));
      if (liveMatch) {
        return liveMatch;
      }
    }

    const fallbackRepoPath = workspaceTerminalPreferredRepoPath ?? globalRepoPath ?? null;
    if (!fallbackRepoPath) return null;

    return workspaceLifecycleRecords.find((record) => (
      !record.archivedAt && record.repoPath === fallbackRepoPath
    )) ?? null;
  }, [currentReviewAgent, globalRepoPath, scopedRepoAgents, selectedSessionAgent, workspaceLifecycleRecords, workspaceTerminalPreferredRepoPath]);

  const archivedWorkspaceCandidate = useMemo(() => {
    const preferredRepoPath = workspaceTerminalPreferredRepoPath ?? globalRepoPath ?? null;
    return [...workspaceLifecycleRecords]
      .filter((record) => Boolean(record.archivedAt))
      .sort((left, right) => {
        const leftPreferred = preferredRepoPath ? left.repoPath === preferredRepoPath : false;
        const rightPreferred = preferredRepoPath ? right.repoPath === preferredRepoPath : false;
        if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
        const leftTime = left.archivedAt ? new Date(left.archivedAt).getTime() : 0;
        const rightTime = right.archivedAt ? new Date(right.archivedAt).getTime() : 0;
        return rightTime - leftTime;
      })[0] ?? null;
  }, [globalRepoPath, workspaceLifecycleRecords, workspaceTerminalPreferredRepoPath]);

  const nextAttentionWorkspace = useMemo(() => {
    if (!workspaceLifecycleSummary.nextAttentionWorkspaceId) return null;
    return workspaceLifecycleRecords.find((record) => record.id === workspaceLifecycleSummary.nextAttentionWorkspaceId) ?? null;
  }, [workspaceLifecycleRecords, workspaceLifecycleSummary.nextAttentionWorkspaceId]);

  /* eslint-disable react-hooks/set-state-in-effect -- preserve the existing auto mark-read behavior without changing logic */
  useEffect(() => {
    if (!currentWorkspaceLifecycleRecord || currentWorkspaceLifecycleRecord.archivedAt || currentWorkspaceLifecycleRecord.unreadCount === 0) {
      return;
    }
    const marker = `${currentWorkspaceLifecycleRecord.id}:${currentWorkspaceLifecycleRecord.lastActivityAt ?? ''}`;
    if (lastMarkedWorkspaceReadRef.current === marker) {
      return;
    }
    lastMarkedWorkspaceReadRef.current = marker;
    void mutateWorkspaceLifecycle('mark_read', currentWorkspaceLifecycleRecord.id).catch(() => undefined);
  }, [currentWorkspaceLifecycleRecord, mutateWorkspaceLifecycle]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return {
    archivedWorkspaceCandidate,
    currentWorkspaceLifecycleRecord,
    mutateWorkspaceLifecycle,
    nextAttentionWorkspace,
    refreshWorkspaceLifecycle,
    setWorkspaceLifecycleRecords,
    setWorkspaceLifecycleSummary,
    workspaceLifecycleRecords,
    workspaceLifecycleSummary,
  };
}
