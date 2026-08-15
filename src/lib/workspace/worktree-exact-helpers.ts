import { access, lstat } from 'node:fs/promises';

import type { ProcessQuiescenceReceipt } from './process-quiescence';
import type {
  ExactParkWorktreeInput,
  ExactWorktreeQuarantineLocation,
  ExactWorktreeQuarantineLocatorInput,
} from './worktree-exact';
import {
  removeExactWorkspaceClaim,
  type ExactWorkspaceClaimRecord,
} from './exact-workspace-claim-state';
import { requiredText } from './worktree-exact-location';

export async function exactPathExists(candidate: string): Promise<boolean> {
  return access(candidate).then(() => true, () => false);
}

export async function exactPathKind(
  candidate: string,
): Promise<'absent' | 'file' | 'directory' | 'symlink' | 'other'> {
  try {
    const entry = await lstat(candidate);
    if (entry.isSymbolicLink()) return 'symlink';
    if (entry.isFile()) return 'file';
    if (entry.isDirectory()) return 'directory';
    return 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
}

export async function verifyFreshProcessQuiescence(
  expectedSessionKey: string,
  workspacePath: string,
  probe: ExactParkWorktreeInput['probeProcessQuiescence'],
): Promise<ProcessQuiescenceReceipt> {
  const sessionKey = requiredText(expectedSessionKey, 'expectedSessionKey');
  const receipt = await probe(sessionKey, workspacePath);
  if (receipt.state !== 'quiescent'
    || receipt.identity.ownership !== 'owned'
    || receipt.identity.sessionKey !== sessionKey) {
    throw new Error('Exact parking refused because fresh owned-workspace process quiescence was not proved.');
  }
  return receipt;
}

export function settleMissingQuarantineMirrorAuthority(
  input: ExactWorktreeQuarantineLocatorInput,
  location: ExactWorktreeQuarantineLocation,
  authority: ExactWorkspaceClaimRecord | null,
  quarantineExists: boolean,
): string | null {
  if (!authority || quarantineExists) return null;
  const preparedWithoutEffect = authority.state === 'prepared'
    && authority.operationId === location.identity
    && authority.expectedPath === location.originalPath
    && authority.claimPath === location.quarantinePath;
  if (!preparedWithoutEffect && authority.state !== 'published') return null;
  removeExactWorkspaceClaim(
    'worktree-quarantine', input.repoPath, input.worktreeId, authority.operationId,
  );
  return preparedWithoutEffect
    ? 'The pre-mirror trusted claim was retired before any filesystem effect.'
    : 'The terminal receipt handoff was completed from trusted authority.';
}
