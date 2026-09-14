import path from 'node:path';

import { withWorktreeMetaTransaction } from '@/lib/worktree/metadata-store';
import {
  assertWorktreeMaterializationIdentity,
  captureWorktreeMaterializationIdentity,
} from '@/lib/worktree/materialization-identity';
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
    return await withWorktreeMetaTransaction(repoPath, async (transaction) => {
      const metadata = (await transaction.readAll())[worktreeId] ?? null;
      if (!metadata || metadata.id !== worktreeId || metadata.claudeManaged) {
        throw new Error('Managed workspace metadata is absent or does not own this path.');
      }
      const parentCandidate = metadata.materializationParentIdentity
        ? await captureWorktreeMaterializationIdentity(
            metadata.materializationParentIdentity.canonicalPath,
          )
        : undefined;
      const parentIdentity = metadata.materializationParentIdentity && parentCandidate
        ? await assertWorktreeMaterializationIdentity(
            metadata.materializationParentIdentity.canonicalPath,
            metadata.materializationParentIdentity,
            { legacyVolumeId: parentCandidate.volumeId },
          )
        : undefined;
      const identity = await assertWorktreeMaterializationIdentity(
        workspacePath,
        metadata.materializationIdentity,
        { legacyVolumeId: parentIdentity?.volumeId },
      );
      if (parentIdentity && identity.volumeId !== parentIdentity.volumeId) {
        throw new Error('Managed workspace materialization volume identity changed.');
      }
      const migrated = {
        ...metadata,
        materializationIdentity: identity,
        ...(parentIdentity ? { materializationParentIdentity: parentIdentity } : {}),
      };
      if (JSON.stringify(migrated) !== JSON.stringify(metadata)) {
        await transaction.save(worktreeId, migrated);
      }
      return { identity, metadata: migrated };
    });
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
