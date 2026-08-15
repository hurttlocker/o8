import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';

import type { Lane } from '@/lib/lane/types';
import {
  materializationAwareExecFile,
  withWorktreeMaterializationExecution,
} from '@/lib/worktree/materialization-execution';
import type { WorkspaceIsolationKind } from '@/lib/worktree/types';
import type { ProcessQuiescenceReceipt } from './process-quiescence';
import { parkExactWorktree } from './worktree-exact';
import {
  finishWorkspaceMaterializationRetirement,
  prepareWorkspaceMaterializationRetirement,
  rollbackWorkspaceMaterializationRetirement,
} from './workspace-materialization-retirement';
import { assertManagedWorkspaceMaterialization } from './managed-materialization-identity';

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

async function verifyQuarantinedDiscard(
  quarantinePath: string,
  branch: string,
  head: string,
): Promise<void> {
  const stat = await lstat(quarantinePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Exact discard quarantine is not a regular directory.');
  }
  await withWorktreeMaterializationExecution(
    quarantinePath,
    { device: stat.dev, inode: stat.ino, canonicalPath: await realpath(quarantinePath) },
    async () => {
      const [{ stdout: actualBranch }, { stdout: actualHead }, { stdout: status }] = await Promise.all([
        materializationAwareExecFile('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
          cwd: quarantinePath, windowsHide: true, timeout: 5_000,
        }),
        materializationAwareExecFile('git', ['rev-parse', 'HEAD'], {
          cwd: quarantinePath, windowsHide: true, timeout: 5_000,
        }),
        materializationAwareExecFile('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
          cwd: quarantinePath,
          windowsHide: true,
          timeout: 10_000,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        }),
      ]);
      if (actualBranch.trim() !== branch || actualHead.trim() !== head || status.trim()) {
        throw new Error('Exact discard quarantine changed after its final clean boundary.');
      }
    },
  );
}

/** Destructively discard only the exact receipted managed workspace. */
export async function discardExactManagedWorktree(input: ExactDiscardInput): Promise<void> {
  const workspacePath = input.lane.worktreePath;
  const sessionKey = input.lane.sessionKey;
  if (!workspacePath || !sessionKey) {
    throw new Error('Exact discard requires a managed workspace path and owned session.');
  }
  const initialProcessReceipt = await input.processProbe(sessionKey, workspacePath);
  if (initialProcessReceipt.state !== 'quiescent') {
    throw new ExactDiscardUnavailableError(
      'workspace_process_not_quiescent',
      `Exact discard refused because owned-workspace process truth is ${initialProcessReceipt.state}.`,
    );
  }
  await prepareWorkspaceMaterializationRetirement(
    input.lane.repoPath,
    workspacePath,
    'discard',
  );
  try {
    await materializationAwareExecFile('git', ['reset', '--hard', 'HEAD'], {
    cwd: workspacePath, windowsHide: true, timeout: 15_000,
    });
    await materializationAwareExecFile('git', ['clean', '-ffdx'], {
    cwd: workspacePath, windowsHide: true, timeout: 15_000,
    });
  const [{ stdout: branch }, { stdout: head }] = await Promise.all([
    materializationAwareExecFile('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: workspacePath, windowsHide: true, timeout: 5_000,
    }),
    materializationAwareExecFile('git', ['rev-parse', 'HEAD'], {
      cwd: workspacePath, windowsHide: true, timeout: 5_000,
    }),
  ]);
  const expectedBranch = branch.trim();
  const expectedHead = head.trim();
  const snapshotFingerprint = createHash('sha256')
    .update(`o8-exact-discard\0${input.lane.packetId ?? ''}\0${expectedBranch}\0${expectedHead}`)
    .digest('hex');
  await parkExactWorktree({
    repoPath: input.lane.repoPath,
    worktreeId: input.worktreeId,
    expectedPath: workspacePath,
    expectedBranch,
    expectedHead,
    expectedSessionKey: sessionKey,
    probeProcessQuiescence: input.processProbe,
    quarantine: { snapshotFingerprint, intent: 'park' },
    verifyQuarantinedClone: (quarantinePath) => (
      verifyQuarantinedDiscard(quarantinePath, expectedBranch, expectedHead)
    ),
  });
  if (expectedBranch !== input.lane.baseBranch) {
    await materializationAwareExecFile(
      'git',
      ['update-ref', '-d', `refs/heads/${expectedBranch}`, expectedHead],
      { cwd: input.lane.repoPath, windowsHide: true, timeout: 5_000 },
    ).catch(() => undefined);
  }
  await finishWorkspaceMaterializationRetirement(workspacePath, 'discard');
  } catch (error) {
    await assertManagedWorkspaceMaterialization(
      input.lane.repoPath,
      workspacePath,
    ).then(() => {
      rollbackWorkspaceMaterializationRetirement(workspacePath, 'discard', error);
    }).catch(() => undefined);
    throw error;
  }
}
