import type { OwnedWorkspaceBinding } from './types';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';

export interface OwnedWorkspaceSpawnGuardInput {
  surfaceId: string;
  sessionPacketId: string | null;
  laneId?: string | null;
  runtimeId?: string | null;
  mode?: 'launch' | 'resume';
  binding: OwnedWorkspaceBinding | null;
  repoPath: string;
}

export type OwnedWorkspaceSpawnDecision =
  | {
      status: 'available';
      source: 'no-snapshot' | 'materialized';
      materializationIdentity?: WorktreeMaterializationIdentity;
    }
  | {
      status: 'held';
      state: 'parkable' | 'hibernating' | 'parked' | 'restoring' | 'retiring' | 'retired';
      note: string;
    }
  | { status: 'unknown'; note: string };

export type OwnedWorkspaceSpawnGuard = (
  input: OwnedWorkspaceSpawnGuardInput,
) => Promise<OwnedWorkspaceSpawnDecision>;

export class OwnedWorkspaceUnavailableError extends Error {
  readonly code = 'owned_workspace_unavailable';
  readonly sideEffect = 'none' as const;
  readonly retryable = false;

  constructor(readonly decision: Exclude<OwnedWorkspaceSpawnDecision, { status: 'available' }>) {
    super(decision.note);
    this.name = 'OwnedWorkspaceUnavailableError';
  }
}

export async function assertOwnedWorkspaceSpawnAvailable(
  input: OwnedWorkspaceSpawnGuardInput,
  guard: OwnedWorkspaceSpawnGuard,
): Promise<Extract<OwnedWorkspaceSpawnDecision, { status: 'available' }>> {
  const decision = await guard(input);
  if (decision.status !== 'available') throw new OwnedWorkspaceUnavailableError(decision);
  return decision;
}
