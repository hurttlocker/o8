/**
 * Self-review stall-guard tuning contract (2026-07-03).
 *
 * The incident: a codex worker that finished its task, committed once, then
 * spent 10+ min in a thorough self-review whose transcript did not match the
 * narrow `selfReviewLikely` regex tripped the `signal-stall` alarm
 * (`self_review_stall_detected`) even though its work was perfectly reviewable.
 * The tuning: never ALARM when committed work exists ahead of base — salvage it
 * to `reviewing` via `force-review` instead. Driven through the REAL probe
 * against a REAL temp git repo (the guard shells out to git), not a mock.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { probeSelfReviewStall, resetSelfReviewStallGuard, type SelfReviewStallProbeInput } from './self-review-stall-guard';

const STALL_SIGNAL_MS = 10 * 60_000;
let repo = '';
const surfaceId = 'codex-owned:test-stall';

function git(...args: string[]) {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'o8-stall-repo-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  resetSelfReviewStallGuard(surfaceId);
});

afterEach(() => {
  resetSelfReviewStallGuard(surfaceId);
  rmSync(repo, { recursive: true, force: true });
});

function laneInput(now: number): SelfReviewStallProbeInput {
  return {
    surfaceId,
    lane: {
      id: 'lane-x', label: 'x', repoPath: repo, worktreePath: repo, baseBranch: 'main',
      status: 'running', packetId: 'pkt-x', runtime: 'codex', lastEventAt: new Date(now).toISOString(),
    },
    transcript: [{ id: '1', role: 'assistant', text: 'working on it' }], // no self-review keywords
    startedAt: now - STALL_SIGNAL_MS - 60_000, // observed >10 min ago
    now,
  };
}

describe('self-review stall guard — committed-work tuning', () => {
  it('does NOT alarm (signal-stall) when reviewable work is committed ahead of base', async () => {
    writeFileSync(join(repo, 'feature.ts'), 'export const x = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'feat: the work');

    const t0 = 1_700_000_000_000;
    // First probe establishes baseline (initialHead = the committed head).
    await probeSelfReviewStall(laneInput(t0));
    // Well past the 10-min alarm window, worktree clean, still no NEW commit.
    const decision = await probeSelfReviewStall(laneInput(t0 + STALL_SIGNAL_MS + 6 * 60_000));
    // The committed work must be salvaged, never alarmed.
    expect(decision.kind).not.toBe('signal-stall');
    expect(['force-review', 'none']).toContain(decision.kind);
  });

  it('STILL alarms when the worker has produced no committed work at all', async () => {
    // Dirty-but-uncommitted counts as commit-worthy for the probe, but there is
    // no diff AGAINST BASE via commits — head === base, hasDiffAgainstBase false.
    writeFileSync(join(repo, 'scratch.txt'), 'nothing real\n'); // untracked only
    const t0 = 1_700_000_000_000;
    // Past the 10-min window with no committed output ahead of base → the
    // genuine stuck alarm. It fires once (guarded by signalSentAt), so collect
    // across both probes rather than assuming which one raises it.
    const first = await probeSelfReviewStall(laneInput(t0));
    const second = await probeSelfReviewStall(laneInput(t0 + STALL_SIGNAL_MS + 60_000));
    expect([first.kind, second.kind]).toContain('signal-stall');
  });
});
