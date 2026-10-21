import type { Lane } from '@/lib/lane/types';
import { materializationAwareExecFile } from '@/lib/worktree/materialization-execution';
import { withWorktreeMetaTransaction } from '@/lib/worktree/metadata-store';
import type { WorkspaceIsolationKind } from '@/lib/worktree/types';
import { completeExactManagedDirectoryRetirement, retireExactManagedDirectory } from './exact-managed-directory-retirement';
import { assertManagedWorkspaceMaterialization, readManagedWorkspaceMaterialization } from './managed-materialization-identity';
import type { ProcessQuiescenceReceipt } from './process-quiescence';
import {
  finishWorkspaceMaterializationRetirement,
  prepareWorkspaceMaterializationRetirement,
  rollbackWorkspaceMaterializationRetirement,
} from './workspace-materialization-retirement';

interface ExactDiscardInput {
  lane: Lane;
  worktreeId: string;
  isolationKind: WorkspaceIsolationKind;
  processProbe: (sessionKey: string, workspacePath: string) => Promise<ProcessQuiescenceReceipt>;
}

export class ExactDiscardUnavailableError extends Error {
  constructor(readonly code: 'workspace_process_not_quiescent', message: string) {
    super(message);
    this.name = 'ExactDiscardUnavailableError';
  }
}

/** Discard source changes through the preservation-bound exact retirement claim. */
export async function discardExactManagedWorktree(input: ExactDiscardInput): Promise<void> {
  const workspacePath = input.lane.worktreePath;
  const sessionKey = input.lane.sessionKey;
  if (!workspacePath || !sessionKey) throw new Error('Exact discard requires a managed workspace path and owned session.');
  const verifyProcess = async (candidatePath: string) => {
    const receipt = await input.processProbe(sessionKey, candidatePath);
    if (receipt.state !== 'quiescent') {
      throw new ExactDiscardUnavailableError('workspace_process_not_quiescent',
        `Exact discard refused because owned-workspace process truth is ${receipt.state}.`);
    }
  };
  await verifyProcess(workspacePath);
  const managed = await readManagedWorkspaceMaterialization(input.lane.repoPath, workspacePath);
  if (managed.metadata.id !== input.worktreeId || managed.metadata.sessionKey !== sessionKey
    || !managed.metadata.materializationParentIdentity) throw new Error('Exact discard manager ownership changed.');
  const snapshot = await prepareWorkspaceMaterializationRetirement(input.lane.repoPath, workspacePath, 'discard');
  if (!snapshot) throw new Error('Exact discard has no persisted packet retirement owner.');
  try {
    await withWorktreeMetaTransaction(input.lane.repoPath, async (transaction) => {
      const current = (await transaction.readAll())[input.worktreeId];
      if (!current || current.materializationIdentity?.device !== managed.identity.device
        || current.materializationIdentity.inode !== managed.identity.inode
        || current.sessionKey !== sessionKey) throw new Error('Exact discard manager receipt changed.');
      await retireExactManagedDirectory({
        repositoryPath: input.lane.repoPath, worktreeId: input.worktreeId,
        directoryPath: workspacePath, identity: managed.identity,
        parentIdentity: managed.metadata.materializationParentIdentity,
        beforeRetirementRename: () => verifyProcess(workspacePath),
        beforeRetirementPurge: verifyProcess,
      });
      await finishWorkspaceMaterializationRetirement(workspacePath, 'discard');
      await transaction.remove(input.worktreeId);
      completeExactManagedDirectoryRetirement(input.lane.repoPath, input.worktreeId);
    });
    if (input.isolationKind === 'git-worktree') {
      await materializationAwareExecFile('git', ['worktree', 'prune'], {
        cwd: input.lane.repoPath, windowsHide: true, timeout: 10_000,
      });
    }
    if (snapshot.branch !== input.lane.baseBranch) {
      await materializationAwareExecFile('git', ['update-ref', '-d', `refs/heads/${snapshot.branch}`, snapshot.headCommit], {
        cwd: input.lane.repoPath, windowsHide: true, timeout: 5_000,
      });
    }
  } catch (error) {
    await assertManagedWorkspaceMaterialization(input.lane.repoPath, workspacePath).then(() => {
      rollbackWorkspaceMaterializationRetirement(workspacePath, 'discard', error);
    }).catch(() => undefined);
    throw error;
  }
}
