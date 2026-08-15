import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';

import { withPacketLifecycleMutationLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { listRepos } from '@/lib/repos/registry';
import {
  getWorkspaceSnapshot,
  listWorkspaceSnapshotTransitions,
  scanWorkspaceSnapshotsForReconciliation,
  transitionWorkspaceSnapshot,
  type WorkspaceSnapshotErrorReceipt,
  type WorkspaceSnapshotRecord,
} from '@/lib/worktree/snapshot-state';
import { verifyImmutableWorkspaceTruth } from './hibernator';
import { probeOwnedSessionProcessQuiescence } from './process-probes';
import {
  repoSetupBoundRecipeKey,
  repoSetupCopyBindingRequirements,
  repoSetupExternalSymlinkAllowlist,
} from './repo-setup';
import {
  rollbackInterruptedRestore,
  verifyRestoredWorkspaceCheckout,
} from './restorer';
import { scanWorkspaceStorageState } from './storage-verifier';
import {
  discardPreparedExactRestore,
  inspectExactWorktreeQuarantine,
  resolveExactWorktreeQuarantine,
} from './worktree-exact';
import { finishWorkspaceMaterializationRetirement } from './workspace-materialization-retirement';

export interface WorkspaceReconciliationReceipt {
  repositoryUuid: string;
  packetId: string;
  fromState: 'parkable' | 'hibernating' | 'restoring' | 'retiring';
  toState: 'materialized' | 'parkable' | 'parked' | 'hibernating' | 'restoring' | 'retiring' | 'retired';
  disposition: 'reconciled' | 'quarantined' | 'unchanged';
  note: string;
}

export interface WorkspaceReconcilerDependencies {
  listRepos: typeof listRepos;
  processProbe: typeof probeOwnedSessionProcessQuiescence;
  scanWorkspace: typeof scanWorkspaceStorageState;
  inspectQuarantine: typeof inspectExactWorktreeQuarantine;
  resolveQuarantine: typeof resolveExactWorktreeQuarantine;
  discardPreparedRestore: typeof discardPreparedExactRestore;
  rollbackRestore: typeof rollbackInterruptedRestore;
}

const DEFAULT_DEPENDENCIES: WorkspaceReconcilerDependencies = {
  listRepos,
  processProbe: probeOwnedSessionProcessQuiescence,
  scanWorkspace: scanWorkspaceStorageState,
  inspectQuarantine: inspectExactWorktreeQuarantine,
  resolveQuarantine: resolveExactWorktreeQuarantine,
  discardPreparedRestore: discardPreparedExactRestore,
  rollbackRestore: rollbackInterruptedRestore,
};

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 1_000);
}

async function pathExists(candidate: string): Promise<boolean> {
  return access(candidate).then(() => true, () => false);
}

function stableTransitionId(snapshot: WorkspaceSnapshotRecord, observation: string): string {
  const digest = createHash('sha256')
    .update(`${snapshot.snapshotFingerprint}:${snapshot.state}:${observation}`)
    .digest('hex')
    .slice(0, 20);
  return `reconcile:${snapshot.state}:${digest}`;
}

function applyReconciliation(
  snapshot: WorkspaceSnapshotRecord,
  transitionId: string,
  toState: WorkspaceReconciliationReceipt['toState'],
  note: string,
  error?: WorkspaceSnapshotErrorReceipt,
): WorkspaceSnapshotRecord {
  if (snapshot.lastTransitionId === transitionId) return snapshot;
  const result = transitionWorkspaceSnapshot({
    repositoryUuid: snapshot.repositoryUuid,
    packetId: snapshot.packetId,
    transitionId,
    expectedState: snapshot.state,
    expectedVersion: snapshot.version,
    expectedGeneration: snapshot.snapshotGeneration,
    toState,
    receipt: { reconciler: true, note },
    error,
  });
  if (result.status === 'missing' || result.status === 'conflict') {
    throw new Error('Workspace reconciliation lost its compare-and-swap.');
  }
  return result.record;
}

function ownedSessionKey(snapshot: WorkspaceSnapshotRecord): string {
  const identity = snapshot.sessionIdentities.find((entry) => entry.kind === 'owned-session');
  if (!identity) throw new Error('Workspace snapshot has no owned session identity.');
  return identity.identity;
}

function restoringOperationId(snapshot: WorkspaceSnapshotRecord): string {
  const transition = listWorkspaceSnapshotTransitions(snapshot.repositoryUuid, snapshot.packetId)
    .findLast((entry) => entry.toState === 'restoring' && entry.transitionId.endsWith(':restoring'));
  if (!transition) throw new Error('Interrupted restore has no exact restoring mutation receipt.');
  return transition.transitionId.slice(0, -':restoring'.length);
}

function allowedRebuildablePaths(repo: Awaited<ReturnType<typeof listRepos>>[number]): string[] {
  return [...new Set([
    ...repo.setup.envFiles,
    'node_modules', '.next/cache', '.turbo', '.venv', 'vendor', 'target', 'Pods', 'DerivedData',
  ])];
}

async function quarantineRefusal(
  snapshot: WorkspaceSnapshotRecord,
  note: string,
): Promise<WorkspaceReconciliationReceipt> {
  const transitionId = stableTransitionId(snapshot, `quarantine:${note}`);
  const error: WorkspaceSnapshotErrorReceipt = {
    code: 'reconcile_quarantined',
    message: note,
    phase: snapshot.state,
    recordedAt: Date.now(),
  };
  const next = applyReconciliation(snapshot, transitionId, snapshot.state, note, error);
  return {
    repositoryUuid: next.repositoryUuid,
    packetId: next.packetId,
    fromState: snapshot.state as WorkspaceReconciliationReceipt['fromState'],
    toState: next.state,
    disposition: next.lastTransitionId === snapshot.lastTransitionId ? 'unchanged' : 'quarantined',
    note,
  };
}

export async function reconcileWorkspaceSnapshot(
  snapshot: WorkspaceSnapshotRecord,
  overrides: Partial<WorkspaceReconcilerDependencies> = {},
): Promise<WorkspaceReconciliationReceipt> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  return withPacketLifecycleMutationLock(snapshot.packetId, async ({ contended }) => {
    const current = getWorkspaceSnapshot(snapshot.repositoryUuid, snapshot.packetId);
    if (!current || (current.state !== 'parkable'
      && current.state !== 'hibernating'
      && current.state !== 'restoring'
      && current.state !== 'retiring')) {
      return {
        repositoryUuid: snapshot.repositoryUuid,
        packetId: snapshot.packetId,
        fromState: snapshot.state as WorkspaceReconciliationReceipt['fromState'],
        toState: (current?.state ?? snapshot.state) as WorkspaceReconciliationReceipt['toState'],
        disposition: 'unchanged',
        note: 'Snapshot no longer needs reconciliation.',
      };
    }
    if (contended) {
      return {
        repositoryUuid: current.repositoryUuid,
        packetId: current.packetId,
        fromState: current.state,
        toState: current.state,
        disposition: 'unchanged',
        note: 'Another packet lifecycle mutation ran first.',
      };
    }
    if (current.state === 'retiring') {
      if (await pathExists(current.originalPath)) {
        return {
          repositoryUuid: current.repositoryUuid,
          packetId: current.packetId,
          fromState: 'retiring',
          toState: 'retiring',
          disposition: 'unchanged',
          note: 'Terminal workspace retirement is held because the exact path still exists.',
        };
      }
      const retired = await finishWorkspaceMaterializationRetirement(current.originalPath);
      if (!retired || retired.state !== 'retired') {
        throw new Error('Terminal workspace retirement did not persist retired truth.');
      }
      return {
        repositoryUuid: retired.repositoryUuid,
        packetId: retired.packetId,
        fromState: 'retiring',
        toState: 'retired',
        disposition: 'reconciled',
        note: 'Terminal workspace retirement was completed after exact path removal.',
      };
    }
    const repo = (await dependencies.listRepos()).find((entry) => entry.id === current.repositoryUuid);
    if (repo) {
      const intent = current.state === 'restoring' ? 'restore-rollback' as const : 'park' as const;
      let inspection;
      try {
        inspection = await dependencies.inspectQuarantine({
          repoPath: repo.localPath,
          worktreeId: path.basename(current.originalPath),
          expectedPath: current.originalPath,
          quarantine: { snapshotFingerprint: current.snapshotFingerprint, intent },
        });
      } catch (error) {
        return quarantineRefusal(
          current,
          `Exact workspace quarantine inspection failed: ${compactError(error)}`,
        );
      }
      if (inspection.state === 'untrusted' || inspection.state === 'conflict') {
        return quarantineRefusal(current, `Exact workspace quarantine is unsafe: ${inspection.note}`);
      }
      if (inspection.state !== 'clear') {
        const sessionKey = ownedSessionKey(current);
        try {
          if (inspection.state === 'quarantined'
            || inspection.state === 'purging'
            || inspection.state === 'completed') {
            await verifyImmutableWorkspaceTruth(repo.localPath, current);
          }
          const allowedIgnoredPaths = allowedRebuildablePaths(repo);
          const allowedExternalSymlinks = await repoSetupExternalSymlinkAllowlist(
            repo,
            current.originalPath,
          );
          const requiredCopyBindings = await repoSetupCopyBindingRequirements(repo);
          if (repoSetupBoundRecipeKey(repo, requiredCopyBindings) !== current.dependencyRecipeKey) {
            throw new Error('Registered copied environment sources changed after the workspace snapshot.');
          }
          await dependencies.resolveQuarantine({
            repoPath: repo.localPath,
            worktreeId: path.basename(current.originalPath),
            expectedPath: current.originalPath,
            quarantine: { snapshotFingerprint: current.snapshotFingerprint, intent },
            disposition: 'remove',
            expectedSessionKey: sessionKey,
            probeProcessQuiescence: dependencies.processProbe,
            verifyQuarantinedClone: async (quarantinePath) => {
              await verifyRestoredWorkspaceCheckout(current, quarantinePath);
              const scan = await dependencies.scanWorkspace(quarantinePath, {
                allowedIgnoredPaths,
                allowedExternalSymlinks,
                requiredCopyBindings,
              });
              if (scan.state !== 'verified_clean') {
                throw new Error('Exact quarantined workspace is not safely rebuildable.');
              }
            },
          });
        } catch (error) {
          return quarantineRefusal(
            current,
            `Exact workspace quarantine recovery failed: ${compactError(error)}`,
          );
        }
        if (inspection.state === 'quarantined'
          || inspection.state === 'purging'
          || inspection.state === 'completed') {
          if (await pathExists(current.originalPath)) {
            return quarantineRefusal(
              current,
              'Exact quarantine removal completed but the original workspace path still exists.',
            );
          }
          const note = 'Interrupted workspace removal was completed from its exact quarantine receipt.';
          const transitionId = stableTransitionId(current, `exact-quarantine-removed:${intent}`);
          const next = applyReconciliation(current, transitionId, 'parked', note);
          return {
            repositoryUuid: next.repositoryUuid,
            packetId: next.packetId,
            fromState: current.state,
            toState: 'parked',
            disposition: 'reconciled',
            note,
          };
        }
      }
    }
    const exists = await pathExists(current.originalPath);
    if (current.state === 'restoring' && exists) {
      if (!repo) {
        return quarantineRefusal(current, 'Registered repository UUID is unavailable.');
      }
      try {
        const next = await dependencies.rollbackRestore({
          repo,
          snapshot: current,
          operationId: restoringOperationId(current),
          error: new Error('The restore process ended before its terminal receipt was persisted.'),
        });
        return {
          repositoryUuid: next.repositoryUuid,
          packetId: next.packetId,
          fromState: current.state,
          toState: next.state,
          disposition: next.state === 'parked' ? 'reconciled' : 'quarantined',
          note: next.lastError?.message ?? 'Interrupted restore recovery completed.',
        };
      } catch (error) {
        return quarantineRefusal(
          current,
          `Interrupted restore rollback failed: ${compactError(error)}`,
        );
      }
    }
    if ((current.state === 'parkable' || current.state === 'hibernating') && exists) {
      let materializedError = '';
      try {
        await verifyRestoredWorkspaceCheckout(current);
      } catch (error) {
        materializedError = compactError(error);
      }
      if (materializedError) {
        const note = `Original path exists but does not match the interrupted workspace: ${materializedError}`;
        const transitionId = stableTransitionId(current, `path-exists-mismatch:${materializedError}`);
        const error: WorkspaceSnapshotErrorReceipt = {
          code: 'reconcile_quarantined',
          message: note,
          phase: current.state,
          recordedAt: Date.now(),
        };
        const next = applyReconciliation(current, transitionId, 'hibernating', note, error);
        return {
          repositoryUuid: next.repositoryUuid,
          packetId: next.packetId,
          fromState: current.state,
          toState: next.state,
          disposition: next.lastTransitionId === current.lastTransitionId ? 'unchanged' : 'quarantined',
          note,
        };
      }
      const transitionId = stableTransitionId(current, 'path-exists-exact');
      const error: WorkspaceSnapshotErrorReceipt = {
        code: current.state === 'parkable' ? 'reconciled_before_parking' : 'reconciled_before_removal',
        message: current.state === 'parkable'
          ? 'The process ended before parking began, and the original path is still intact.'
          : 'The original path still exists, so no destructive removal is inferred.',
        phase: current.state,
        recordedAt: Date.now(),
      };
      const next = applyReconciliation(current, transitionId, 'materialized', error.message, error);
      return {
        repositoryUuid: next.repositoryUuid,
        packetId: next.packetId,
        fromState: current.state,
        toState: 'materialized',
        disposition: 'reconciled',
        note: error.message,
      };
    }

    let immutableError = '';
    if (!repo) immutableError = 'Registered repository UUID is unavailable.';
    else {
      try {
        await verifyImmutableWorkspaceTruth(repo.localPath, current);
      } catch (error) {
        immutableError = compactError(error);
      }
    }

    if (!exists && !immutableError && current.state !== 'parkable') {
      if (current.state === 'restoring' && repo) {
        const isolation = current.sessionIdentities
          .find((entry) => entry.kind === 'workspace-isolation')?.identity;
        if (isolation !== 'git-worktree' && isolation !== 'apfs-cow-clone') {
          return quarantineRefusal(current, 'Interrupted restore has no exact isolation receipt.');
        }
        let disposition: 'absent' | 'removed' | 'unknown';
        try {
          disposition = await dependencies.discardPreparedRestore({
            repoPath: repo.localPath,
            worktreeId: path.basename(current.originalPath),
            expectedPath: current.originalPath,
            branch: current.branch,
            head: current.headCommit,
            tree: current.treeSha,
            isolationKind: isolation,
          });
        } catch (error) {
          return quarantineRefusal(
            current,
            `Interrupted restore stage recovery failed: ${compactError(error)}`,
          );
        }
        if (disposition === 'unknown') {
          return quarantineRefusal(
            current,
            'Interrupted restore stage ownership could not be proven; manual recovery is required.',
          );
        }
      }
      const note = current.state === 'hibernating'
        ? 'Original path is absent and immutable recovery truth is complete.'
        : 'Interrupted restore left no path and immutable recovery truth is complete.';
      const transitionId = stableTransitionId(current, `path-absent:${note}`);
      const error = current.state === 'restoring' ? {
        code: 'restore_interrupted_path_absent',
        message: note,
        phase: 'restoring',
        recordedAt: Date.now(),
      } satisfies WorkspaceSnapshotErrorReceipt : undefined;
      const next = applyReconciliation(current, transitionId, 'parked', note, error);
      return {
        repositoryUuid: next.repositoryUuid,
        packetId: next.packetId,
        fromState: current.state,
        toState: 'parked',
        disposition: 'reconciled',
        note,
      };
    }

    const note = exists
      ? 'Interrupted restore still has a materialized path; setup and session binding cannot be inferred.'
      : `Original path is absent but immutable recovery truth failed: ${immutableError}`;
    const transitionId = stableTransitionId(current, `${exists ? 'path-exists' : 'path-absent'}:${immutableError}`);
    const error: WorkspaceSnapshotErrorReceipt = {
      code: 'reconcile_quarantined',
      message: note,
      phase: current.state,
      recordedAt: Date.now(),
    };
    const next = applyReconciliation(current, transitionId, current.state, note, error);
    return {
      repositoryUuid: next.repositoryUuid,
      packetId: next.packetId,
      fromState: current.state,
      toState: current.state,
      disposition: next.lastTransitionId === current.lastTransitionId ? 'unchanged' : 'quarantined',
      note,
    };
  });
}

export async function reconcileInterruptedWorkspaces(): Promise<WorkspaceReconciliationReceipt[]> {
  const results: WorkspaceReconciliationReceipt[] = [];
  const scan = scanWorkspaceSnapshotsForReconciliation();
  for (const corruption of scan.corruptions) {
    console.warn(
      `[workspace-reconcile] Quarantined corrupt snapshot ${corruption.repositoryUuid}/${corruption.packetId}: ${corruption.note}`,
    );
  }
  for (const snapshot of scan.snapshots) {
    try {
      results.push(await reconcileWorkspaceSnapshot(snapshot));
    } catch (error) {
      console.warn(
        `[workspace-reconcile] Snapshot ${snapshot.repositoryUuid}/${snapshot.packetId} remains quarantined: ${compactError(error)}`,
      );
    }
  }
  return results;
}
