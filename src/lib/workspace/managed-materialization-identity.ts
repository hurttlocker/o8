import path from 'node:path';

import { withWorktreeMetaTransaction } from '@/lib/worktree/metadata-store';
import { assertWorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import type { WorktreeMetaEntry } from '@/lib/worktree/types';

const MATERIALIZATION_REFUSAL_EXIT_CODE = 78;

export class ManagedMaterializationRefusalError extends Error {
  readonly code = MATERIALIZATION_REFUSAL_EXIT_CODE;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ManagedMaterializationRefusalError';
  }
}

export interface ManagedWorkspaceMaterializationReceipt {
  identity: NonNullable<WorktreeMetaEntry['materializationIdentity']>;
  metadata: WorktreeMetaEntry;
}

/** Read and prove the exact manager receipt that owns the public workspace path. */
export async function readManagedWorkspaceMaterialization(
  repoPath: string,
  workspacePath: string,
): Promise<ManagedWorkspaceMaterializationReceipt> {
  try {
    const worktreeId = path.basename(path.resolve(workspacePath));
    const metadata = await withWorktreeMetaTransaction(repoPath, async (transaction) => (
      (await transaction.readAll())[worktreeId] ?? null
    ));
    if (!metadata || metadata.id !== worktreeId || metadata.claudeManaged) {
      throw new Error('Managed workspace metadata is absent or does not own this path.');
    }
    return {
      identity: await assertWorktreeMaterializationIdentity(
        workspacePath,
        metadata.materializationIdentity,
      ),
      metadata,
    };
  } catch (error) {
    if (error instanceof ManagedMaterializationRefusalError) throw error;
    throw new ManagedMaterializationRefusalError(
      error instanceof Error ? error.message : 'Managed workspace ownership could not be verified.',
      { cause: error },
    );
  }
}

/** Prove the path still names the exact manager-created directory receipt. */
export async function assertManagedWorkspaceMaterialization(
  repoPath: string,
  workspacePath: string,
): Promise<NonNullable<WorktreeMetaEntry['materializationIdentity']>> {
  return (await readManagedWorkspaceMaterialization(repoPath, workspacePath)).identity;
}
