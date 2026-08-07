import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const { isAncestorCommit } = await import('@/lib/orchestrator/operator-mission-service/merge-truth');

/**
 * #1763 — `approve-merge` reported `merged: true` for work that never merged.
 *
 * Shape: a packet whose agent produced NO changes gets reconciled while
 * head == base, so the BASE commit is recorded as its merge SHA. The branch
 * later advances with real work (also reachable via retry and steer). The
 * release short-circuit only verified that the recorded merge SHA was on main's
 * ancestry — and a base commit is on main's ancestry forever — so the packet
 * stayed "already released" and the real diff was never merged.
 *
 * This locks the git-level premise the guard depends on: the recorded SHA
 * staying an ancestor is NOT evidence that the packet's branch has landed.
 * A full-path test through alreadyReleasedResultForPacket needs that helper
 * exported (there is precedent in merge.ts for isTerminalReleaseLane) and is
 * the follow-up.
 */
const roots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitAll(cwd: string, message: string): string {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('stale release claim when the packet branch advances (#1763)', () => {
  it('distinguishes "recorded merge SHA is on main" from "the packet work landed"', async () => {
    const repo = mkdtempSync(join(os.tmpdir(), 'o8-release-claim-'));
    roots.push(repo);
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.name', 'o8-test']);
    git(repo, ['config', 'user.email', 'o8@example.test']);
    writeFileSync(join(repo, 'app.txt'), 'hello\n');
    const baseSha = commitAll(repo, 'base');

    // The zero-diff reconciliation: the packet branch is created and the agent
    // changes nothing, so head == base and the BASE is recorded as the merge.
    git(repo, ['branch', 'packet/inline-1']);
    const recordedMergeSha = baseSha;

    // At this instant the old check is correct — nothing was left behind.
    expect(await isAncestorCommit(repo, recordedMergeSha, 'HEAD')).toBe(true);
    expect(await isAncestorCommit(repo, 'packet/inline-1', 'HEAD')).toBe(true);

    // Now real work lands on the packet branch (retry, steer, or a later run).
    git(repo, ['checkout', '--quiet', 'packet/inline-1']);
    writeFileSync(join(repo, 'app.txt'), 'hello\nwindows dispatch works\n');
    commitAll(repo, 'real work');
    git(repo, ['checkout', '--quiet', 'main']);

    // THE BUG: the recorded merge SHA is STILL on main's ancestry — a base
    // commit always is — so the old guard keeps reporting "already released".
    expect(await isAncestorCommit(repo, recordedMergeSha, 'HEAD')).toBe(true);

    // THE FIX: the packet's own branch head is NOT on main, which is what
    // actually answers "did this packet's work land?". main must be unchanged.
    expect(await isAncestorCommit(repo, 'packet/inline-1', 'HEAD')).toBe(false);
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(baseSha);
  });
});
