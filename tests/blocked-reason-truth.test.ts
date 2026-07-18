/**
 * #1469 — dispatch failures must be visible, and local-ahead bases must not
 * self-conflict.
 *
 * Field incident: unpushed no-ff merges on LOCAL main; every dispatch rebased
 * the fresh worktree onto origin/main, linearized the unpushed merges,
 * conflicted, retried 5x — while the packet card said only 'Awaiting operator
 * input' (the real error lived in next-server.log).
 *
 * Two fixes, two tests through real entry points:
 *   (a) the packet reconciler preserves the real blockedReason (or maps the
 *       lane's rebase_conflict label to a human sentence) for awaiting_input
 *       lanes instead of hardcoding the generic string;
 *   (b) the worktree rebase targets LOCAL base when it is strictly ahead of
 *       origin/base (real git, through the real launch_session command).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-blocked-reason-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const launchRuntimeSurfaceMock = vi.fn(async () => ({
  ok: true as const,
  surfaceId: 'codex-owned:local-ahead-test',
  note: 'launched',
}));
vi.mock('@/lib/runtime/actions', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/runtime/actions')>();
  return { ...original, launchRuntimeSurface: launchRuntimeSurfaceMock };
});

const { reconcileOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { dispatch } = await import('@/lib/lane/commands');
const { createLane, updateLane } = await import('@/lib/lane/registry');
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd }).toString().trim();
}

function packetFixture(overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id: 'pkt-1469',
    referenceLabel: 'PKT-1469',
    title: 'feat conflicted dispatch',
    summary: 'Do work.',
    status: 'running',
    queueState: 'queued',
    releaseState: 'pending',
    blockedReason: null,
    lane: null,
    review: null,
    runtime: 'codex',
    dependencyPacketIds: [],
    dependencyLabels: [],
    attemptCount: 0,
    lastEventAt: '2026-07-18T00:00:00.000Z',
    lastEventLabel: 'created',
    recoveryCount: 0,
    typecheckAutoRetries: 0,
    orchestratorThreadId: null,
    ...overrides,
  } as OrchestratorPacket;
}

describe('#1469a — the reconciler preserves the real awaiting_input reason', () => {
  it('maps a rebase_conflict lane label to a human sentence instead of the generic string', () => {
    const state = createEmptyOrchestratorMissionState();
    state.packets.push(packetFixture());

    const reconciled = reconcileOrchestratorMissionState(state, {
      laneSnapshots: [],
      runtimeTruth: [],
      domainLanes: [{
        packetId: 'pkt-1469',
        laneId: 'lane-1469',
        status: 'awaiting_input',
        sessionKey: null,
        lastEventLabel: 'rebase_conflict',
      }],
    });

    const packet = reconciled.packets.find((candidate) => candidate.id === 'pkt-1469');
    expect(packet?.status).toBe('blocked');
    expect(packet?.blockedReason).toContain('conflict');
    expect(packet?.blockedReason).not.toBe('Awaiting operator input');
  });

  it('keeps an explicit packet blockedReason set by the dispatch fold-back', () => {
    const state = createEmptyOrchestratorMissionState();
    state.packets.push(packetFixture({
      blockedReason: 'Rebase onto origin/main failed. Conflicting files: live-changes.ts',
    }));

    const reconciled = reconcileOrchestratorMissionState(state, {
      laneSnapshots: [],
      runtimeTruth: [],
      domainLanes: [{
        packetId: 'pkt-1469',
        laneId: 'lane-1469',
        status: 'awaiting_input',
        sessionKey: null,
        lastEventLabel: 'rebase_conflict',
      }],
    });

    const packet = reconciled.packets.find((candidate) => candidate.id === 'pkt-1469');
    expect(packet?.blockedReason).toContain('Conflicting files: live-changes.ts');
  });
});

describe('#1469b — rebase targets local base when it is strictly ahead of origin', () => {
  it('launches on the local commit instead of conflicting against a behind origin', { timeout: 30_000 }, async () => {
    // Origin at commit A.
    const originPath = join(dataDir, 'origin-ahead');
    execFileSync('git', ['init', '-q', '-b', 'main', originPath]);
    git(originPath, 'config', 'user.email', 'test@o8.test');
    git(originPath, 'config', 'user.name', 'o8 test');
    writeFileSync(join(originPath, 'base.txt'), 'base\n');
    git(originPath, 'add', 'base.txt');
    git(originPath, 'commit', '-q', '-m', 'commit A: base');

    // The operator's checkout: clone, then land an UNPUSHED commit on local
    // main (the no-ff-merge-without-push incident shape).
    const clonePath = join(dataDir, 'ahead-clone');
    execFileSync('git', ['clone', '-q', '--local', originPath, clonePath]);
    git(clonePath, 'config', 'user.email', 'test@o8.test');
    git(clonePath, 'config', 'user.name', 'o8 test');
    writeFileSync(join(clonePath, 'local.txt'), 'unpushed local work\n');
    git(clonePath, 'add', 'local.txt');
    git(clonePath, 'commit', '-q', '-m', 'unpushed: local main ahead');
    const localSha = git(clonePath, 'rev-parse', 'main');

    // The lane's worktree is a second clone OF THE OPERATOR CHECKOUT (origin
    // remote = the checkout, same as .cortex-worktrees clones of repoPath),
    // cut before the local commit… so its branch is behind its origin.
    // To model the incident precisely: worktree branch from commit A, its
    // origin/main at commit A (never pushed), local main in the WORKTREE'S
    // repo at the unpushed commit. Simplest faithful setup: clone the
    // operator checkout, then in the worktree fetch shows origin/main at the
    // unpushed commit too — so instead we point the worktree's origin at the
    // ORIGINAL origin (still at A) while its local main carries the unpushed
    // commit, exactly the repoPath state the manager rebases within.
    const worktreePath = join(dataDir, 'ahead-worktree');
    execFileSync('git', ['clone', '-q', '--local', clonePath, worktreePath]);
    git(worktreePath, 'config', 'user.email', 'test@o8.test');
    git(worktreePath, 'config', 'user.name', 'o8 test');
    git(worktreePath, 'remote', 'set-url', 'origin', originPath);
    git(worktreePath, 'fetch', '-q', 'origin');
    // Cut the branch from commit A (origin's tip), NOT local main — so the
    // branch does not already contain the unpushed commit. Only rebasing onto
    // LOCAL main can bring it in; rebasing onto origin/main (commit A) is a
    // no-op that leaves the branch behind the truth the merge will land on.
    git(worktreePath, 'checkout', '-q', '-B', 'issue/local-ahead', 'origin/main');

    const lane = createLane({
      label: 'local ahead lane',
      repoPath: clonePath,
      branch: 'issue/local-ahead',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-local-ahead',
    });
    updateLane(lane.id, { worktreePath });

    const result = await dispatch({
      verb: 'launch_session',
      laneId: lane.id,
      prompt: 'build on the real base',
      actor: 'orchestrator',
    });

    expect(result.ok).toBe(true);

    // The branch must contain the unpushed local commit — the old code
    // rebased onto origin/main (commit A) and never saw it.
    const branchTip = git(worktreePath, 'rev-parse', 'issue/local-ahead');
    const containsLocal = execFileSync(
      'git', ['merge-base', '--is-ancestor', localSha, branchTip],
      { cwd: worktreePath },
    );
    expect(containsLocal.toString()).toBe('');
  });
});
