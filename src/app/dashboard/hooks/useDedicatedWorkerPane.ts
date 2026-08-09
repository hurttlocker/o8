'use client';

import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { RegisteredRepo, TerminalTabHandle } from '@/components/desktop/workspace-terminal/types';
import { findLeafByContentKind, findTile, getFirstLeaf, splitTile } from '@/lib/tiles/operations';
import type { TileLayout } from '@/lib/tiles/types';
import type { OrchestratorRuntime, WorkerLaunchContext } from '@/lib/orchestrator/types';
import type { WorkspaceScopeEntry } from '../types';

export interface DispatchedWorkerLane {
  laneId?: string | null;
  packetId?: string | null;
  packetReferenceLabel?: string | null;
  packetTitle?: string | null;
  sessionKey: string;
  runtime: OrchestratorRuntime;
  repoPath: string;
  status?: string | null;
  branch?: string | null;
  launchContext?: WorkerLaunchContext | null;
}

interface WorkerPaneTabIdentity {
  sessionKey?: string;
  laneId?: string | null;
  packetId?: string | null;
}

export function workerPaneTabMatchesLane(
  tab: WorkerPaneTabIdentity,
  lane: Pick<DispatchedWorkerLane, 'sessionKey' | 'laneId' | 'packetId'>,
): boolean {
  return tab.sessionKey === lane.sessionKey
    || (lane.laneId != null && tab.laneId === lane.laneId)
    || (lane.packetId != null && tab.packetId === lane.packetId);
}

interface UseDedicatedWorkerPaneArgs {
  activeTileId: string | null;
  pendingHandlesRef: MutableRefObject<Map<string, (handle: TerminalTabHandle) => void>>;
  setActiveTileId: Dispatch<SetStateAction<string | null>>;
  setTileLayout: Dispatch<SetStateAction<TileLayout>>;
  tileLayout: TileLayout;
  workspaceHandlesRef: MutableRefObject<Map<string, TerminalTabHandle>>;
}

export function dispatchedLaneRepo(
  targetScope: WorkspaceScopeEntry | null,
  lane: { repoPath: string; branch?: string | null },
): RegisteredRepo {
  if (targetScope) {
    return {
      name: targetScope.name,
      localPath: targetScope.localPath,
      branch: targetScope.branch ?? 'main',
      readiness: targetScope.readiness ?? null,
      remoteUrl: targetScope.remoteUrl ?? undefined,
      registryRepoId: targetScope.registryRepoId,
      isWorktree: targetScope.isWorktree ?? false,
      worktreeStatus: targetScope.worktreeStatus ?? null,
    };
  }
  return {
    name: lane.repoPath.replace(/\/+$/, '').split('/').filter(Boolean).at(-1) ?? lane.repoPath,
    localPath: lane.repoPath,
    branch: lane.branch ?? 'main',
  };
}

export function useDedicatedWorkerPane({
  activeTileId,
  pendingHandlesRef,
  setActiveTileId,
  setTileLayout,
  tileLayout,
  workspaceHandlesRef,
}: UseDedicatedWorkerPaneArgs) {
  const activeTileIdRef = useRef(activeTileId);
  activeTileIdRef.current = activeTileId;
  const tileLayoutRef = useRef(tileLayout);
  tileLayoutRef.current = tileLayout;
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const findTargetForLane = useCallback((lane: Pick<DispatchedWorkerLane, 'sessionKey' | 'laneId' | 'packetId'>) => {
    for (const [tileId, handle] of workspaceHandlesRef.current.entries()) {
      if (handle.getTabsSnapshot().tabs.some((tab) => workerPaneTabMatchesLane(tab, lane))) {
        return { tileId, handle };
      }
    }
    return null;
  }, [workspaceHandlesRef]);

  const createTile = useCallback((repoPath: string): string | null => {
    const current = tileLayoutRef.current;
    const activeTile = activeTileIdRef.current ? findTile(current.root, activeTileIdRef.current) : null;
    const targetLeaf = activeTile?.type === 'leaf'
      ? activeTile
      : findLeafByContentKind(current.root, 'terminal')
        ?? findLeafByContentKind(current.root, 'workspace')
        ?? getFirstLeaf(current.root);
    const result = splitTile(
      current.root,
      targetLeaf.id,
      'vertical',
      { kind: 'terminal', repoPath, createdFromSplit: true },
      0.55,
    );
    if (!result.newTileId) return null;
    const next = { ...current, root: result.root };
    tileLayoutRef.current = next;
    setTileLayout(next);
    setActiveTileId(result.newTileId);
    return result.newTileId;
  }, [setActiveTileId, setTileLayout]);

  const waitForDedicatedTarget = useCallback(async (repoPath: string, lane: Pick<DispatchedWorkerLane, 'sessionKey' | 'laneId' | 'packetId'>) => {
    const prior = queueRef.current;
    let release!: () => void;
    queueRef.current = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      const restored = findTargetForLane(lane);
      if (restored) {
        setActiveTileId(restored.tileId);
        return restored;
      }
      const tileId = createTile(repoPath);
      if (!tileId) throw new Error('Unable to create a dedicated worker pane.');
      const handle = await new Promise<TerminalTabHandle | null>((resolve) => {
        const timeoutId = window.setTimeout(() => {
          pendingHandlesRef.current.delete(tileId);
          resolve(null);
        }, 12_000);
        pendingHandlesRef.current.set(tileId, (nextHandle) => {
          window.clearTimeout(timeoutId);
          resolve(nextHandle);
        });
      });
      if (!handle) throw new Error('The dedicated worker pane did not become ready in time.');
      return { tileId, handle };
    } finally {
      release();
    }
  }, [createTile, findTargetForLane, pendingHandlesRef, setActiveTileId]);

  return { findTargetForLane, waitForDedicatedTarget };
}
