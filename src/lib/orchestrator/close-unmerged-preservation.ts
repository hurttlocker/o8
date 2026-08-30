import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import type { BranchPreservationFailure, BranchPreservationReceipt } from './close-unmerged-shared';

const execFileAsync = promisify(execFile);

interface ClosePreservationTarget {
  id: string;
  repoPath: string;
  worktreePath: string | null;
  branch: string;
  baseBranch: string;
}

export interface ClosePreservationResult {
  receipt: BranchPreservationReceipt;
  failure: BranchPreservationFailure | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeRefPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'packet';
}

async function readCommit(repoPath: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      windowsHide: true,
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 5_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      windowsHide: true,
      cwd: repoPath,
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function deleteRef(repoPath: string, ref: string): Promise<void> {
  await execFileAsync('git', ['update-ref', '-d', ref], {
    windowsHide: true,
    cwd: repoPath,
    timeout: 5_000,
  }).catch(() => undefined);
}

/**
 * Classify close preservation against actual Git state. A missing branch and a
 * branch already contained by the base carry no recoverable work. A genuinely
 * unmerged head is banked under preserved/* so the explicit close disposition
 * can retire the lane without making the commits unreachable.
 */
export async function classifyClosePreservation(
  packetId: string,
  lane: ClosePreservationTarget,
): Promise<ClosePreservationResult> {
  const branchRef = `refs/heads/${lane.branch}`;
  const repoBranchHead = await readCommit(lane.repoPath, branchRef);
  const worktreePath = lane.worktreePath?.trim() || null;
  const worktreeHead = worktreePath && existsSync(worktreePath)
    ? await readCommit(worktreePath, 'HEAD')
    : null;

  if (!repoBranchHead && !worktreeHead) {
    return {
      receipt: { branch: lane.branch, reason: 'branch-absent', ref: null },
      failure: null,
    };
  }

  const temporaryRef = `refs/heads/o8-close-check/${safeRefPart(lane.id)}`;
  let head = worktreeHead ?? repoBranchHead!;
  if (worktreeHead && worktreeHead !== repoBranchHead) {
    try {
      await execFileAsync('git', ['fetch', worktreePath!, `+HEAD:${temporaryRef}`], {
        windowsHide: true,
        cwd: lane.repoPath,
        timeout: 30_000,
      });
      const fetchedHead = await readCommit(lane.repoPath, temporaryRef);
      if (!fetchedHead) {
        await deleteRef(lane.repoPath, temporaryRef);
        return {
          receipt: { branch: lane.branch, reason: 'branch-absent', ref: null },
          failure: {
            code: 'branch_preservation_failed',
            reason: 'ref_verification_failed',
            branch: lane.branch,
            ref: temporaryRef,
            message: `Fetched close-check ref ${temporaryRef} was not readable.`,
          },
        };
      }
      head = fetchedHead;
    } catch (error) {
      await deleteRef(lane.repoPath, temporaryRef);
      return {
        receipt: { branch: lane.branch, reason: 'branch-absent', ref: null },
        failure: {
          code: 'branch_preservation_failed',
          reason: 'ref_write_failed',
          branch: lane.branch,
          ref: temporaryRef,
          message: errorMessage(error),
        },
      };
    }
  }

  if (await isAncestor(lane.repoPath, head, lane.baseBranch || 'main')) {
    await deleteRef(lane.repoPath, temporaryRef);
    return {
      receipt: { branch: lane.branch, reason: 'already-merged', ref: null },
      failure: null,
    };
  }

  const preservedBranch: `preserved/${string}` = `preserved/packet-${safeRefPart(packetId)}-${safeRefPart(lane.id).slice(0, 12)}`;
  const preservedRef = `refs/heads/${preservedBranch}`;
  let writeError: unknown = null;
  try {
    await execFileAsync('git', ['update-ref', preservedRef, head], {
      windowsHide: true,
      cwd: lane.repoPath,
      timeout: 10_000,
    });
  } catch (error) {
    writeError = error;
  }
  const verified = await readCommit(lane.repoPath, preservedRef);
  if (verified !== head) {
    await deleteRef(lane.repoPath, temporaryRef);
    return {
      receipt: { branch: lane.branch, reason: preservedBranch, ref: preservedRef },
      failure: {
        code: 'branch_preservation_failed',
        reason: writeError ? 'ref_write_failed' : 'ref_verification_failed',
        branch: lane.branch,
        ref: preservedRef,
        message: writeError
          ? errorMessage(writeError)
          : `expected ${head}, read ${verified ?? 'missing'}`,
      },
    };
  }
  await deleteRef(lane.repoPath, temporaryRef);

  return {
    receipt: { branch: lane.branch, reason: preservedBranch, ref: preservedRef },
    failure: null,
  };
}
