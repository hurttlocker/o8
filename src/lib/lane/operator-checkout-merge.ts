import {
  currentBranch,
  git,
  gitErrorMessage,
  isAncestor,
} from '@/lib/lane/worktree-merge-git';

export interface OperatorCheckoutMergeSafety {
  foundBranch: string;
  neededBranch: string;
  conflictingPaths: string[];
  safe: boolean;
  detail: string | null;
}

function nullDelimitedPaths(output: string): string[] {
  return output.split('\0').filter((entry) => entry.length > 0);
}

async function changedPaths(cwd: string, args: string[]): Promise<string[]> {
  const { stdout } = await git(cwd, args, { timeout: 10_000 });
  return nullDelimitedPaths(stdout);
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export async function inspectOperatorCheckoutMergeSafety(input: {
  repoPath: string;
  candidateCwd: string;
  baseBranch: string;
}): Promise<OperatorCheckoutMergeSafety> {
  const foundBranch = await currentBranch(input.repoPath);
  if (foundBranch !== input.baseBranch) {
    return {
      foundBranch,
      neededBranch: input.baseBranch,
      conflictingPaths: [],
      safe: true,
      detail: null,
    };
  }

  try {
    const [unstaged, staged, untracked, packetChanges] = await Promise.all([
      changedPaths(input.repoPath, ['diff', '--name-only', '-z']),
      changedPaths(input.repoPath, ['diff', '--cached', '--name-only', '-z']),
      changedPaths(input.repoPath, ['ls-files', '--others', '--exclude-standard', '-z']),
      changedPaths(input.candidateCwd, [
        'diff',
        '--name-only',
        '-z',
        `refs/heads/${input.baseBranch}...HEAD`,
      ]),
    ]);
    const dirtyPaths = [...new Set([...unstaged, ...staged, ...untracked])];
    const conflictingPaths = dirtyPaths.filter((dirtyPath) => (
      packetChanges.some((packetPath) => pathsOverlap(dirtyPath, packetPath))
    ));
    const safe = conflictingPaths.length === 0;
    return {
      foundBranch,
      neededBranch: input.baseBranch,
      conflictingPaths,
      safe,
      detail: safe
        ? null
        : `o8 found operator checkout branch "${foundBranch}"; merge needs base branch "${input.baseBranch}". Uncommitted changes to ${conflictingPaths.join(', ')} would be disturbed by the fast-forward.`,
    };
  } catch (error) {
    return {
      foundBranch,
      neededBranch: input.baseBranch,
      conflictingPaths: [],
      safe: false,
      detail: `o8 found operator checkout branch "${foundBranch}"; merge needs base branch "${input.baseBranch}". Checkout safety could not be verified: ${gitErrorMessage(error)}`,
    };
  }
}

export async function fastForwardBaseBranch(input: {
  repoPath: string;
  baseBranch: string;
  candidateRef: string;
  candidateSha: string;
}): Promise<{ foundBranch: string }> {
  const foundBranch = await currentBranch(input.repoPath);
  try {
    if (foundBranch === input.baseBranch) {
      await git(input.repoPath, ['merge', '--ff-only', input.candidateRef], { timeout: 60_000 });
      return { foundBranch };
    }

    const baseRef = `refs/heads/${input.baseBranch}`;
    const { stdout } = await git(input.repoPath, ['rev-parse', '--verify', baseRef], { timeout: 5000 });
    const previousBaseSha = stdout.trim();
    if (!(await isAncestor(input.repoPath, previousBaseSha, input.candidateRef))) {
      throw new Error(`${baseRef} is not an ancestor of ${input.candidateRef}.`);
    }
    await git(input.repoPath, [
      'update-ref',
      '-m',
      `o8 fast-forward ${input.baseBranch}`,
      baseRef,
      input.candidateSha,
      previousBaseSha,
    ], { timeout: 5000 });
    return { foundBranch };
  } catch (error) {
    throw new Error(
      `o8 found operator checkout branch "${foundBranch}"; merge needs base branch "${input.baseBranch}". Fast-forward failed: ${gitErrorMessage(error)}`,
    );
  }
}
