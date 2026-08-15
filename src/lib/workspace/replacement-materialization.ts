import path from 'node:path';

import { getLane } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { findRepoByLocalPath } from '@/lib/repos/registry';
import { beginWorkspaceSnapshotGeneration } from '@/lib/worktree/snapshot-generation';
import type { WorkspaceSnapshotRecord } from '@/lib/worktree/snapshot-state';
import { withWorktreeMetaTransaction } from '@/lib/worktree/metadata-store';
import { assertWorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import type { WorktreeMetaEntry } from '@/lib/worktree/types';
import {
  ensureWorkspaceRecoveryRef,
  readImmutableWorkspaceTruth,
  verifyImmutableWorkspaceTruth,
  workspaceRecoveryRef,
} from './hibernator';

export class ReplacementWorkspaceMaterializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplacementWorkspaceMaterializationError';
  }
}

export interface ReplacementWorkspaceLaunchProof {
  laneId: string;
  packetId: string;
  workspacePath: string;
  runtimeId: string;
  surfaceId: string;
}

export interface ReplacementWorkspaceMaterializationDependencies {
  getLane: typeof getLane;
  findRepoByLocalPath: typeof findRepoByLocalPath;
  readWorktreeMetadata: (repoPath: string, worktreeId: string) => Promise<WorktreeMetaEntry | null>;
}

const DEFAULT_DEPENDENCIES: ReplacementWorkspaceMaterializationDependencies = {
  getLane,
  findRepoByLocalPath,
  readWorktreeMetadata: (repoPath, worktreeId) => withWorktreeMetaTransaction(
    repoPath,
    async (transaction) => (await transaction.readAll())[worktreeId] ?? null,
  ),
};

function refuse(message: string): never {
  throw new ReplacementWorkspaceMaterializationError(message);
}

function exactPrelaunchLane(
  input: ReplacementWorkspaceLaunchProof,
  dependencies: ReplacementWorkspaceMaterializationDependencies,
): Lane {
  const lane = dependencies.getLane(input.laneId);
  if (!lane) refuse('Replacement workspace pre-launch lane is missing.');
  const mismatches = [
    lane.packetId !== input.packetId && 'packet',
    lane.ownership !== 'managed' && 'ownership',
    lane.status !== 'launching' && 'status',
    lane.sessionKey !== null && 'session',
    (!lane.worktreePath || path.resolve(lane.worktreePath) !== path.resolve(input.workspacePath)) && 'workspace path',
    lane.runtime !== input.runtimeId && 'runtime',
  ].filter(Boolean);
  if (mismatches.length > 0) {
    refuse(`Replacement workspace lane does not match pre-launch ${mismatches.join(', ')} truth.`);
  }
  return lane;
}

function immutableAnchorMatches(
  snapshot: WorkspaceSnapshotRecord,
  truth: Awaited<ReturnType<typeof readImmutableWorkspaceTruth>>,
): boolean {
  return snapshot.branch === truth.branch
    && snapshot.baseCommit === truth.baseCommit
    && snapshot.headCommit === truth.headCommit
    && snapshot.treeSha === truth.treeSha
    && snapshot.recoveryRef === truth.recoveryRef
    && snapshot.diffFingerprint === truth.diffFingerprint;
}

/**
 * Promote one parked packet snapshot to the exact replacement lane before its
 * first owned child starts. Git protection precedes the durable generation CAS,
 * so either side of a crash can replay without losing the prior recovery anchor.
 */
export async function materializeReplacementWorkspace(
  snapshot: WorkspaceSnapshotRecord,
  input: ReplacementWorkspaceLaunchProof,
  dependencies = DEFAULT_DEPENDENCIES,
): Promise<WorkspaceSnapshotRecord> {
  const lane = exactPrelaunchLane(input, dependencies);
  const repo = await dependencies.findRepoByLocalPath(lane.repoPath);
  if (!repo || repo.id !== snapshot.repositoryUuid) {
    refuse('Replacement workspace repository does not match the parked snapshot.');
  }
  if (snapshot.packetId !== input.packetId
    || path.resolve(snapshot.originalPath) !== path.resolve(input.workspacePath)) {
    refuse('Replacement workspace path does not match the parked snapshot.');
  }
  const worktreeId = path.basename(input.workspacePath);
  const metadata = await dependencies.readWorktreeMetadata(repo.localPath, worktreeId);
  if (!metadata
    || metadata.id !== worktreeId
    || metadata.claudeManaged
    || metadata.branchName !== lane.branch
    || metadata.agentType !== input.runtimeId
    || metadata.status !== 'ready') {
    refuse('Replacement workspace is not the exact manager-provisioned lane workspace.');
  }
  try {
    await assertWorktreeMaterializationIdentity(input.workspacePath, metadata.materializationIdentity);
  } catch (error) {
    refuse(error instanceof Error ? error.message : 'Replacement workspace ownership could not be verified.');
  }

  if (snapshot.state === 'materialized') {
    if (snapshot.laneId === lane.id) {
      const truth = await readImmutableWorkspaceTruth(repo, lane, snapshot.snapshotGeneration);
      if (metadata.isolationKind && metadata.isolationKind !== truth.isolationKind) {
        refuse('Replacement workspace isolation does not match manager metadata.');
      }
      if (!immutableAnchorMatches(snapshot, truth)) {
        refuse('Materialized replacement Git truth changed before launch replay.');
      }
      await verifyImmutableWorkspaceTruth(repo.localPath, truth);
      return snapshot;
    }
  }
  if (snapshot.state !== 'parked' && snapshot.state !== 'materialized') {
    refuse(`Workspace snapshot is ${snapshot.state}; replacement launch remains held.`);
  }

  const nextGeneration = snapshot.snapshotGeneration + 1;
  const truth = {
    ...await readImmutableWorkspaceTruth(repo, lane, nextGeneration),
    recoveryRef: workspaceRecoveryRef(repo.id, input.packetId, nextGeneration),
  };
  if (metadata.isolationKind && metadata.isolationKind !== truth.isolationKind) {
    refuse('Replacement workspace isolation does not match manager metadata.');
  }
  await ensureWorkspaceRecoveryRef(repo.localPath, input.workspacePath, truth);
  exactPrelaunchLane(input, dependencies);
  const advanced = beginWorkspaceSnapshotGeneration({
    repositoryUuid: repo.id,
    packetId: input.packetId,
    missionId: snapshot.missionId,
    laneId: lane.id,
    originalPath: path.resolve(input.workspacePath),
    branch: truth.branch,
    baseCommit: truth.baseCommit,
    headCommit: truth.headCommit,
    treeSha: truth.treeSha,
    recoveryRef: truth.recoveryRef,
    diffFingerprint: truth.diffFingerprint,
    dependencyRecipeKey: snapshot.dependencyRecipeKey,
    sessionIdentities: [
      {
        kind: 'owned-session',
        identity: input.surfaceId,
        runtime: input.runtimeId,
        bindingId: `packet:${input.packetId}`,
      },
      {
        kind: 'workspace-isolation',
        identity: truth.isolationKind,
        runtime: null,
        bindingId: null,
      },
    ],
    reservation: snapshot.reservation,
    creationId: `replacement-launch:${input.packetId}:g${nextGeneration}:${lane.id}`,
    expectedState: snapshot.state,
    expectedVersion: snapshot.version,
    expectedGeneration: snapshot.snapshotGeneration,
    receipt: {
      source: 'replacement-owned-launch',
      laneId: lane.id,
      surfaceId: input.surfaceId,
      isolationKind: truth.isolationKind,
    },
  });
  if (advanced.status === 'missing' || advanced.status === 'conflict') {
    refuse('Replacement workspace generation lost its durable compare-and-swap.');
  }
  return advanced.record;
}
