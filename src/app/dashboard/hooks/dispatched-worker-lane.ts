import type { RegisteredRepo } from '@/components/desktop/workspace-terminal/types';
import type { OrchestratorRuntime, WorkerLaunchContext } from '@/lib/orchestrator/types';
import { isOrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
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

export function dispatchedWorkerRuntime(value: unknown): OrchestratorRuntime {
  return isOrchestratorRuntime(value) ? value : 'codex';
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
