import { isDispatchableRuntime } from './runtime-capabilities';
import type { OrchestratorLaneBinding } from './types';

export function normalizeLaneBinding(value: unknown): OrchestratorLaneBinding | null {
  if (!value || typeof value !== 'object') return null;
  const lane = value as Partial<OrchestratorLaneBinding>;
  if (typeof lane.tileId !== 'string' || typeof lane.tabId !== 'string') return null;
  return {
    tileId: lane.tileId,
    tabId: lane.tabId,
    repoPath: typeof lane.repoPath === 'string' ? lane.repoPath : null,
    worktreePath: typeof lane.worktreePath === 'string' ? lane.worktreePath : null,
    runtime: isDispatchableRuntime(lane.runtime) ? lane.runtime : 'codex',
    sessionKey: typeof lane.sessionKey === 'string' ? lane.sessionKey : null,
    laneId: typeof lane.laneId === 'string' ? lane.laneId : null,
    lastHeartbeatAt: typeof lane.lastHeartbeatAt === 'string' ? lane.lastHeartbeatAt : null,
    lastEventAt: typeof lane.lastEventAt === 'string' ? lane.lastEventAt : null,
    lastEventLabel: typeof lane.lastEventLabel === 'string' ? lane.lastEventLabel : null,
    mergeMode: lane.mergeMode === 'pr_only' || lane.mergeMode === 'direct' ? lane.mergeMode : undefined,
    mergeModeNote: typeof lane.mergeModeNote === 'string' ? lane.mergeModeNote : null,
    dependencyMaterializationMode: lane.dependencyMaterializationMode === 'native'
      || lane.dependencyMaterializationMode === 'image' ? lane.dependencyMaterializationMode : null,
  };
}
