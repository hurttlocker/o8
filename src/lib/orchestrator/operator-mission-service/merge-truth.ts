import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[], opts: { timeout?: number; maxBuffer?: number } = {}) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: opts.timeout ?? 10_000,
    maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function readGitHead(cwd: string) {
  return git(cwd, ['rev-parse', 'HEAD'], { timeout: 5000 });
}

export async function isAncestorCommit(cwd: string, ancestorSha: string, descendantRef = 'HEAD') {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', ancestorSha, descendantRef], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function commitPatchId(cwd: string, commitSha: string) {
  const show = await git(cwd, ['show', '--format=', '--no-ext-diff', commitSha], {
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!show.trim()) return null;
  const result = spawnSync('git', ['patch-id', '--stable'], {
    cwd,
    input: show,
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  return result.stdout.trim().split(/\s+/)[0] ?? null;
}

export async function compareCommitPatchIds(cwd: string, reviewedSha: string, currentSha: string) {
  const reviewedPatchId = await commitPatchId(cwd, reviewedSha);
  const currentPatchId = await commitPatchId(cwd, currentSha);
  return {
    matches: Boolean(reviewedPatchId && currentPatchId && reviewedPatchId === currentPatchId),
    patchId: reviewedPatchId && reviewedPatchId === currentPatchId ? reviewedPatchId : null,
    reviewedPatchId,
    currentPatchId,
  };
}
