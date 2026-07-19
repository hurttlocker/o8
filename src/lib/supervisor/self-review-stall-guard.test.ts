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
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  preserveSelfReviewStallWork,
  probeSelfReviewStall,
  resetSelfReviewStallGuard,
  type SelfReviewStallProbeInput,
} from './self-review-stall-guard';

const STALL_SIGNAL_MS = 10 * 60_000;
const SELF_REVIEW_HARD_DEADLINE_MS = 5 * 60_000;
let repo = '';
let ownedSessionDir = '';
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
  git('checkout', '-qb', 'packet');
  resetSelfReviewStallGuard(surfaceId);
});

afterEach(() => {
  resetSelfReviewStallGuard(surfaceId);
  if (ownedSessionDir) rmSync(ownedSessionDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

function writeOwnedTranscript(activityAt: number): void {
  const ownedRoot = process.env.CORTEX_IDE_OWNED_CODEX_ROOT;
  if (!ownedRoot) throw new Error('Test isolation did not configure the owned Codex root.');
  ownedSessionDir = join(ownedRoot, 'self-review-stall-test');
  const runsDir = join(ownedSessionDir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(ownedSessionDir, 'session.json'), JSON.stringify({ surfaceId }));
  const runPath = join(runsDir, 'active.jsonl');
  writeFileSync(runPath, '{"type":"item.started"}\n');
  const activityDate = new Date(activityAt);
  utimesSync(runPath, activityDate, activityDate);
}

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

  it('keeps fresh-transcript WIP running past the self-review hard deadline', async () => {
    const now = Date.now();
    const scratchPath = join(repo, 'in-progress.ts');
    writeFileSync(scratchPath, 'export const stillWorking = true;\n');
    const oldEdit = new Date(now - SELF_REVIEW_HARD_DEADLINE_MS - 60_000);
    utimesSync(scratchPath, oldEdit, oldEdit);
    writeOwnedTranscript(now - 1_000);

    const input = laneInput(now);
    input.startedAt = now - STALL_SIGNAL_MS - 60_000;
    input.transcript = [{ id: 'review', role: 'assistant', text: 'Reviewing my diff and iterating on the remaining cases.' }];

    await expect(probeSelfReviewStall(input)).resolves.toEqual({ kind: 'none' });
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toContain('in-progress.ts');
  });

  it('auto-commits genuinely idle WIP before the force-review transition', async () => {
    const now = Date.now();
    const scratchPath = join(repo, 'idle-wip.ts');
    writeFileSync(scratchPath, 'export const preserved = true;\n');
    const staleAt = now - SELF_REVIEW_HARD_DEADLINE_MS - 60_000;
    const staleDate = new Date(staleAt);
    utimesSync(scratchPath, staleDate, staleDate);
    writeOwnedTranscript(staleAt);

    const input = laneInput(now);
    input.startedAt = now - STALL_SIGNAL_MS - 60_000;
    input.transcript = [{ id: 'review', role: 'assistant', text: 'Reviewing my diff before completion.' }];
    const firstDecision = await probeSelfReviewStall(input);
    expect(firstDecision.kind).toBe('signal-stall');
    input.now = now + 16_000;
    const decision = await probeSelfReviewStall(input);

    expect(decision.kind).toBe('force-review');
    if (decision.kind !== 'force-review') throw new Error('Expected force-review decision.');
    const preservation = await preserveSelfReviewStallWork(input.lane, decision.cwd);
    expect(preservation).toMatchObject({ committed: true, hasReviewableDiff: true });
    expect(preservation.captureRef).toBe('refs/o8-capture/lane-x');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toBe('');
    expect(execFileSync('git', ['rev-list', '--count', 'main..HEAD'], { cwd: repo, encoding: 'utf8' }).trim()).toBe('1');
  });
});
