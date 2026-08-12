'use client';

import { useEffect, useRef } from 'react';
import type {
  RegisteredRepo,
  TerminalTab,
} from '@/components/desktop/workspace-terminal/types';
import { WORKSPACE_THREAD_ID_EVENT } from '@/components/desktop/workspace-terminal/utils';
import {
  outsideWorkerPlacementKey,
  registerOutsideWorkerSplitMountSurface,
  type OutsideWorkerSplitRequest,
} from '@/lib/orchestrator/outside-worker-split';

interface UseOutsideWorkerSplitMountArgs {
  active: boolean;
  activeTabId: string | null;
  workspaceId: string;
  tabs: ReadonlyArray<TerminalTab>;
  selectTab: (tabId: string) => void;
  spawnOrchestratorTab: (
    repo?: RegisteredRepo | null,
    forceFresh?: boolean,
    outsideWorkerHost?: boolean,
  ) => string;
}

function normalizeRepoPath(value: string | null | undefined): string {
  return value?.trim().replace(/\\/g, '/').replace(/\/+$/, '') ?? '';
}

function repoForRequest(request: OutsideWorkerSplitRequest): RegisteredRepo {
  const localPath = normalizeRepoPath(request.repoPath);
  return {
    localPath,
    name: localPath.split('/').filter(Boolean).pop() ?? localPath,
  };
}

function matchingOrchestratorTab(
  tabs: ReadonlyArray<TerminalTab>,
  request: OutsideWorkerSplitRequest,
  activeTabId: string | null,
): TerminalTab | null {
  const repoPath = normalizeRepoPath(request.repoPath);
  const threadId = request.launchContext?.parentThreadId?.trim() ?? '';
  const matches = tabs.filter((tab) => (
    tab.kind === 'orchestrator'
    && normalizeRepoPath(tab.repo?.localPath) === repoPath
    && (!threadId || tab.orchestratorThreadId === threadId)
  ));
  if (threadId) return matches[0] ?? null;
  return matches.find((tab) => tab.id === activeTabId) ?? matches[0] ?? null;
}

/** Mount an unclaimed outside worker in the selected workspace surface. */
export function useOutsideWorkerSplitMount({
  active,
  activeTabId,
  workspaceId,
  tabs,
  selectTab,
  spawnOrchestratorTab,
}: UseOutsideWorkerSplitMountArgs): void {
  const stateRef = useRef({ activeTabId, tabs, selectTab, spawnOrchestratorTab });
  const pendingMountsRef = useRef(new Map<string, string>());
  useEffect(() => {
    stateRef.current = { activeTabId, tabs, selectTab, spawnOrchestratorTab };
    for (const [placementKey, tabId] of pendingMountsRef.current) {
      if (tabs.some((tab) => tab.id === tabId)) pendingMountsRef.current.delete(placementKey);
    }
  }, [activeTabId, selectTab, spawnOrchestratorTab, tabs]);

  useEffect(() => registerOutsideWorkerSplitMountSurface({
    workspaceId,
    getPlacement: () => ({
      active,
      repoPaths: stateRef.current.tabs.flatMap((tab) => (
        tab.repo?.localPath ? [tab.repo.localPath] : []
      )),
      threadIds: stateRef.current.tabs.flatMap((tab) => (
        tab.orchestratorThreadId ? [tab.orchestratorThreadId] : []
      )),
    }),
    mount: (request) => {
      const current = stateRef.current;
      const existing = matchingOrchestratorTab(current.tabs, request, current.activeTabId);
      if (existing) {
        current.selectTab(existing.id);
        return existing.id;
      }
      const placementKey = outsideWorkerPlacementKey(request);
      const pendingTabId = pendingMountsRef.current.get(placementKey);
      if (pendingTabId) {
        current.selectTab(pendingTabId);
        return pendingTabId;
      }
      // React has not committed the first tab yet when a parallel batch arrives.
      // Reuse only the exact pending placement; different repos/parents still get
      // independent hosts, while same-repo workers form one inner split/mesh.
      const tabId = current.spawnOrchestratorTab(repoForRequest(request), true, true);
      pendingMountsRef.current.set(placementKey, tabId);
      const threadId = request.launchContext?.parentThreadId?.trim();
      if (threadId) {
        window.dispatchEvent(new CustomEvent(WORKSPACE_THREAD_ID_EVENT, {
          detail: { tabId, threadId },
        }));
      }
      return tabId;
    },
  }), [active, workspaceId]);
}
