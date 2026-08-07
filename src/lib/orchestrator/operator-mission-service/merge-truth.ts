import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[], opts: { timeout?: number; maxBuffer?: number } = {}) {
  const { stdout } = await execFileAsync('git', args, {
    windowsHide: true,
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

function patchIdOfDiff(cwd: string, diff: string): string | null {
  if (!diff.trim()) return null;
  const result = spawnSync('git', ['patch-id', '--stable'], {
    windowsHide: true,
    cwd,
    input: diff,
    timeout: 10_000,
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  return result.stdout.trim().split(/\s+/)[0] ?? null;
}

/**
 * Patch-id of the AGGREGATE branch content: merge-base(baseRef, sha)..sha.
 *
 * Adversarial F4 — the tip-commit-only patch-id (`git show <sha>`) was blind
 * to a rebase folding moved-base content into a NON-tip commit: the tip's
 * isolated diff stayed identical while the branch content materially changed,
 * and a stale review was silently carried. The aggregate range diff is what
 * the review actually approved, so it is what must match.
 */
async function rangePatchId(cwd: string, baseRef: string, sha: string) {
  let mergeBase: string;
  try {
    mergeBase = await git(cwd, ['merge-base', baseRef, sha], { timeout: 10_000 });
  } catch {
    return null;
  }
  if (!mergeBase) return null;
  const diff = await git(cwd, ['diff', '--no-ext-diff', `${mergeBase}..${sha}`], {
    timeout: 15_000,
    maxBuffer: 32 * 1024 * 1024,
  }).catch(() => '');
  return patchIdOfDiff(cwd, diff);
}

export async function compareCommitPatchIds(cwd: string, reviewedSha: string, currentSha: string, baseRef: string) {
  // Fail-closed: when either aggregate patch-id can't be computed (unreachable
  // base, GC'd pre-rebase objects), the review is NOT carried — the operator
  // re-reviews instead of a stale approval silently surviving.
  const reviewedPatchId = await rangePatchId(cwd, baseRef, reviewedSha);
  const currentPatchId = await rangePatchId(cwd, baseRef, currentSha);
  return {
    matches: Boolean(reviewedPatchId && currentPatchId && reviewedPatchId === currentPatchId),
    patchId: reviewedPatchId && reviewedPatchId === currentPatchId ? reviewedPatchId : null,
    reviewedPatchId,
    currentPatchId,
  };
}
