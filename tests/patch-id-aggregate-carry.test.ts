/**
 * Adversarial F4 — review carry must compare AGGREGATE branch content
 * (merge-base..sha), not the tip commit's isolated diff.
 *
 * A rebase can fold moved-base content into a NON-tip commit (e.g. a
 * strategy resolution silently dropping the branch's edit) while the tip
 * commit's own diff stays byte-identical. The old tip-only patch-id then
 * carried a stale approval onto materially different content. Real git
 * repos, both directions: the lossy rebase must NOT match; the clean
 * content-preserving rebase still must.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { compareCommitPatchIds } from '@/lib/orchestrator/operator-mission-service/merge-truth';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd }).toString().trim();
}

function initRepo(root: string): string {
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  git(root, 'config', 'user.email', 'test@o8.test');
  git(root, 'config', 'user.name', 'o8 test');
  return root;
}

describe('review carry patch-id is aggregate, not tip-only (F4)', () => {
  it('a rebase that silently drops branch content does NOT match; a clean rebase does', async () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'o8-patchid-'));

    // ── Lossy case ──
    const lossy = initRepo(join(dir, 'lossy'));
    writeFileSync(join(lossy, 'base.txt'), 'line1\n');
    git(lossy, 'add', '.'); git(lossy, 'commit', '-q', '-m', 'base');
    git(lossy, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(lossy, 'base.txt'), 'branch-version\n');
    git(lossy, 'commit', '-aqm', 'c1: branch edit');
    writeFileSync(join(lossy, 'other.txt'), 'tip work\n');
    git(lossy, 'add', '.'); git(lossy, 'commit', '-qm', 'c2: tip');
    const reviewedTip = git(lossy, 'rev-parse', 'HEAD');
    // Base moves, conflicting with c1.
    git(lossy, 'checkout', '-q', 'main');
    writeFileSync(join(lossy, 'base.txt'), 'main-version\n');
    git(lossy, 'commit', '-aqm', 'main advances');
    // Rebase with upstream-wins: c1's edit is silently dropped, tip diff unchanged.
    git(lossy, 'checkout', '-q', 'feature');
    git(lossy, 'rebase', '-q', '-X', 'ours', 'main');
    const rebasedTip = git(lossy, 'rev-parse', 'HEAD');

    const lossyComparison = await compareCommitPatchIds(lossy, reviewedTip, rebasedTip, 'main');
    // The branch LOST its base.txt edit — a stale approval must not carry.
    expect(lossyComparison.matches).toBe(false);

    // ── Clean case ──
    const clean = initRepo(join(dir, 'clean'));
    writeFileSync(join(clean, 'base.txt'), 'line1\n');
    git(clean, 'add', '.'); git(clean, 'commit', '-q', '-m', 'base');
    git(clean, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(clean, 'feature.txt'), 'branch work\n');
    git(clean, 'add', '.'); git(clean, 'commit', '-qm', 'c1');
    writeFileSync(join(clean, 'other.txt'), 'tip work\n');
    git(clean, 'add', '.'); git(clean, 'commit', '-qm', 'c2: tip');
    const cleanReviewed = git(clean, 'rev-parse', 'HEAD');
    git(clean, 'checkout', '-q', 'main');
    writeFileSync(join(clean, 'unrelated.txt'), 'main work\n');
    git(clean, 'add', '.'); git(clean, 'commit', '-qm', 'main advances (disjoint)');
    git(clean, 'checkout', '-q', 'feature');
    git(clean, 'rebase', '-q', 'main');
    const cleanRebased = git(clean, 'rev-parse', 'HEAD');

    const cleanComparison = await compareCommitPatchIds(clean, cleanReviewed, cleanRebased, 'main');
    // Content-preserving rebase — the carry still works.
    expect(cleanComparison.matches).toBe(true);
    expect(cleanComparison.patchId).toBeTruthy();
  }, 30_000);
});
