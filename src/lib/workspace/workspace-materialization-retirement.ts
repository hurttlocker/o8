import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { spokenReviewSnapshotFingerprint } from '@/lib/lane/lane-diff-facts';
import { archiveLane, listLanes } from '@/lib/lane/registry';
import { findRepoByLocalPath } from '@/lib/repos/registry';
import {
  createWorkspaceSnapshot,
  listWorkspaceSnapshotTransitions,
  listWorkspaceSnapshotsByOriginalPath,
  listWorkspaceSnapshotsByRepositoryUuid,
  transitionWorkspaceSnapshot,
  type WorkspaceSnapshotRecord,
} from '@/lib/worktree/snapshot-state';
import type { WorkspaceSnapshotJson } from '@/lib/worktree/snapshot-state-types';
import {
  materializationAwareExecFile,
  withWorktreeMaterializationExecution,
} from '@/lib/worktree/materialization-execution';
import { ensureWorkspaceRecoveryRef } from './hibernator';
import { readManagedWorkspaceMaterialization } from './managed-materialization-identity';

export type WorkspaceRetirementAction = 'pr' | 'merge' | 'discard' | 'cleanup';

interface WorkspaceRetirementReceipt {
  [key: string]: WorkspaceSnapshotJson;
  terminalAction: WorkspaceRetirementAction;
  laneId: string | null;
}

function transitionId(
  snapshot: WorkspaceSnapshotRecord,
  action: WorkspaceRetirementAction,
  phase: 'begin' | 'finish',
): string {
  return `retire:${snapshot.snapshotGeneration}:${action}:${phase}:${snapshot.version}`;
}

function retirementReceipt(
  snapshot: WorkspaceSnapshotRecord,
  action: WorkspaceRetirementAction,
): WorkspaceRetirementReceipt {
  return { terminalAction: action, laneId: snapshot.laneId };
}

function recordedAction(snapshot: WorkspaceSnapshotRecord): WorkspaceRetirementAction | null {
  const transition = listWorkspaceSnapshotTransitions(snapshot.repositoryUuid, snapshot.packetId)
    .findLast((entry) => entry.receipt?.terminalAction !== undefined);
  const action = transition?.receipt?.terminalAction;
  return action === 'pr' || action === 'merge' || action === 'discard' || action === 'cleanup'
    ? action
    : null;
}

function exactSnapshot(workspacePath: string): WorkspaceSnapshotRecord | null {
  const matches = listWorkspaceSnapshotsByOriginalPath(path.resolve(workspacePath));
  if (matches.length > 1) {
    throw new Error('Workspace retirement found ambiguous durable materialization truth.');
  }
  return matches[0] ?? null;
}

function archiveTerminalLane(snapshot: WorkspaceSnapshotRecord, action: WorkspaceRetirementAction): void {
  if (!snapshot.laneId || action === 'cleanup') return;
  const endings = {
    pr: { outcome: 'pr_opened' as const, outcomeNote: 'Pull request opened; local workspace retired.' },
    merge: { outcome: 'merged' as const, outcomeNote: 'Merged; local workspace retired.' },
    discard: { outcome: 'discarded' as const, outcomeNote: 'Discarded by the operator.' },
  };
  archiveLane(snapshot.laneId, 'user', endings[action]);
}

async function gitValue(workspacePath: string, args: string[]): Promise<string> {
  const { stdout } = await materializationAwareExecFile('git', args, {
    cwd: workspacePath,
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Bind ordinary never-parked manager truth to a durable terminal snapshot before cleanup. */
export async function prepareWorkspaceMaterializationRetirement(
  repoPath: string,
  workspacePath: string,
  action: WorkspaceRetirementAction,
): Promise<WorkspaceSnapshotRecord | null> {
  const existing = exactSnapshot(workspacePath);
  if (existing) return beginWorkspaceMaterializationRetirement(workspacePath, action);
  const repo = await findRepoByLocalPath(repoPath);
  if (!repo) return null;
  const lanes = listLanes().filter((lane) => (
    lane.packetId?.trim()
    && lane.worktreePath
    && path.resolve(lane.repoPath) === path.resolve(repo.localPath)
    && path.resolve(lane.worktreePath) === path.resolve(workspacePath)
  ));
  if (lanes.length === 0) return null;
  if (lanes.length !== 1) throw new Error('Workspace retirement found ambiguous managed lane truth.');
  const lane = lanes[0]!;
  const packetId = lane.packetId!;
  const managed = await readManagedWorkspaceMaterialization(repo.localPath, workspacePath);
  const isolationKind = managed.metadata.isolationKind;
  if (isolationKind !== 'git-worktree' && isolationKind !== 'apfs-cow-clone') {
    throw new Error('Workspace retirement has no exact isolation-provider receipt.');
  }
  const identity = managed.identity;
  await withWorktreeMaterializationExecution(workspacePath, identity, async () => {
    const [branch, headCommit, treeSha, baseTip] = await Promise.all([
      gitValue(workspacePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      gitValue(workspacePath, ['rev-parse', '--verify', 'HEAD^{commit}']),
      gitValue(workspacePath, ['rev-parse', '--verify', 'HEAD^{tree}']),
      gitValue(workspacePath, ['rev-parse', '--verify', `${lane.baseBranch}^{commit}`]),
    ]);
    if (branch !== lane.branch) throw new Error('Workspace retirement branch no longer matches its lane.');
    const baseCommit = await gitValue(workspacePath, ['merge-base', baseTip, headCommit]);
    const recoveryRef = `refs/o8/recovery/${repo.id}/${packetId}`;
    const diffFingerprint = spokenReviewSnapshotFingerprint(headCommit, baseCommit, treeSha);
    await ensureWorkspaceRecoveryRef(repo.localPath, workspacePath, {
      branch,
      baseCommit,
      headCommit,
      treeSha,
      recoveryRef,
      diffFingerprint,
      isolationKind,
    });
    createWorkspaceSnapshot({
      repositoryUuid: repo.id,
      packetId,
      laneId: lane.id,
      originalPath: path.resolve(workspacePath),
      branch,
      baseCommit,
      headCommit,
      treeSha,
      recoveryRef,
      diffFingerprint,
      sessionIdentities: lane.sessionKey
        ? [{ kind: 'owned-session', identity: lane.sessionKey }]
        : [],
      creationId: `retire:${action}:create`,
      receipt: { terminalBootstrap: true, terminalAction: action },
    });
  });
  return beginWorkspaceMaterializationRetirement(workspacePath, action);
}

/** Persist terminal cleanup intent before any exact path removal begins. */
export function beginWorkspaceMaterializationRetirement(
  workspacePath: string,
  action: WorkspaceRetirementAction,
): WorkspaceSnapshotRecord | null {
  const snapshot = exactSnapshot(workspacePath);
  if (!snapshot) return null;
  if (snapshot.state === 'retiring' || snapshot.state === 'retired') {
    if (recordedAction(snapshot) !== action) {
      throw new Error('Workspace retirement action conflicts with its durable terminal receipt.');
    }
    return snapshot;
  }
  if (snapshot.state !== 'materialized') {
    throw new Error(`Workspace retirement requires materialized truth, not ${snapshot.state}.`);
  }
  const result = transitionWorkspaceSnapshot({
    repositoryUuid: snapshot.repositoryUuid,
    packetId: snapshot.packetId,
    transitionId: transitionId(snapshot, action, 'begin'),
    expectedState: 'materialized',
    expectedVersion: snapshot.version,
    expectedGeneration: snapshot.snapshotGeneration,
    toState: 'retiring',
    receipt: retirementReceipt(snapshot, action),
  });
  if (result.status === 'missing' || result.status === 'conflict') {
    throw new Error('Workspace retirement lost its durable begin compare-and-swap.');
  }
  return result.record;
}

/** Finalize only after the exact public materialization path is absent. */
export async function finishWorkspaceMaterializationRetirement(
  workspacePath: string,
  action?: WorkspaceRetirementAction,
): Promise<WorkspaceSnapshotRecord | null> {
  const snapshot = exactSnapshot(workspacePath);
  if (!snapshot) return null;
  const durableAction = recordedAction(snapshot);
  if (!durableAction || (action && action !== durableAction)) {
    throw new Error('Workspace retirement finish has no matching durable action receipt.');
  }
  if (snapshot.state === 'retired') {
    archiveTerminalLane(snapshot, durableAction);
    return snapshot;
  }
  if (snapshot.state !== 'retiring') {
    throw new Error(`Workspace retirement cannot finish from ${snapshot.state}.`);
  }
  const occupant = await lstat(path.resolve(workspacePath)).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (occupant) throw new Error('Workspace retirement cannot finish while its public path is occupied.');
  const result = transitionWorkspaceSnapshot({
    repositoryUuid: snapshot.repositoryUuid,
    packetId: snapshot.packetId,
    transitionId: transitionId(snapshot, durableAction, 'finish'),
    expectedState: 'retiring',
    expectedVersion: snapshot.version,
    expectedGeneration: snapshot.snapshotGeneration,
    toState: 'retired',
    receipt: retirementReceipt(snapshot, durableAction),
  });
  if (result.status === 'missing' || result.status === 'conflict') {
    throw new Error('Workspace retirement lost its durable finish compare-and-swap.');
  }
  archiveTerminalLane(result.record, durableAction);
  return result.record;
}

/** Roll back only a proven pre-removal failure whose exact public path remains manager-owned. */
export function rollbackWorkspaceMaterializationRetirement(
  workspacePath: string,
  action: WorkspaceRetirementAction,
  error: unknown,
): WorkspaceSnapshotRecord | null {
  const snapshot = exactSnapshot(workspacePath);
  if (!snapshot) return null;
  if (snapshot.state === 'materialized') return snapshot;
  if (snapshot.state !== 'retiring' || recordedAction(snapshot) !== action) {
    throw new Error('Workspace retirement rollback does not match durable terminal truth.');
  }
  const result = transitionWorkspaceSnapshot({
    repositoryUuid: snapshot.repositoryUuid,
    packetId: snapshot.packetId,
    transitionId: `retire:${snapshot.snapshotGeneration}:${action}:rollback:${snapshot.version}`,
    expectedState: 'retiring',
    expectedVersion: snapshot.version,
    expectedGeneration: snapshot.snapshotGeneration,
    toState: 'materialized',
    receipt: {
      terminalAction: action,
      rollback: true,
      note: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    },
  });
  if (result.status === 'missing' || result.status === 'conflict') {
    throw new Error('Workspace retirement rollback lost its durable compare-and-swap.');
  }
  return result.record;
}

export function getWorkspaceRetirementAction(
  workspacePath: string,
): WorkspaceRetirementAction | null {
  const snapshot = exactSnapshot(workspacePath);
  return snapshot && (snapshot.state === 'retiring' || snapshot.state === 'retired')
    ? recordedAction(snapshot)
    : null;
}

/** Read exact terminal replay truth without advancing durable or physical state. */
export function findWorkspaceMaterializationRetirement(
  repositoryUuid: string,
  worktreeId: string,
  action: WorkspaceRetirementAction,
): WorkspaceSnapshotRecord | null {
  const matches = listWorkspaceSnapshotsByRepositoryUuid(repositoryUuid).filter((snapshot) => (
    path.basename(path.resolve(snapshot.originalPath)) === worktreeId
    && (snapshot.state === 'retiring' || snapshot.state === 'retired')
  ));
  if (matches.length > 1) {
    throw new Error('Workspace retirement replay found ambiguous durable worktree truth.');
  }
  const snapshot = matches[0];
  if (!snapshot) return null;
  if (recordedAction(snapshot) !== action) {
    throw new Error('Workspace retirement replay action conflicts with durable terminal truth.');
  }
  return snapshot;
}

/** Resolve an exact retry after physical cleanup completed before the route response. */
export async function replayWorkspaceMaterializationRetirement(
  repositoryUuid: string,
  worktreeId: string,
  action: WorkspaceRetirementAction,
): Promise<WorkspaceSnapshotRecord | null> {
  const snapshot = findWorkspaceMaterializationRetirement(repositoryUuid, worktreeId, action);
  if (!snapshot) return null;
  return finishWorkspaceMaterializationRetirement(snapshot.originalPath, action);
}
