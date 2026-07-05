import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const launchMock = vi.hoisted(() => ({
  calls: [] as Array<{ packetId?: string; runtime?: string; branchName?: string }>,
}));

vi.mock('@/lib/runtime/actions', () => ({
  launchRuntimeSurface: vi.fn(async (input: { packetId?: string; runtime?: string; branchName?: string; repoPath: string }) => {
    launchMock.calls.push({
      packetId: input.packetId,
      runtime: input.runtime,
      branchName: input.branchName,
    });
    return {
      ok: true,
      surfaceId: `codex-owned:${input.packetId}`,
      note: 'mock launch',
      worktree: { path: input.repoPath },
    };
  }),
}));

const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { hasReviewableCompletionDiff } = await import('@/lib/supervisor/completion-verification');
const {
  MAX_PARALLEL_DISPATCHES,
  RUNTIME_PARALLEL_CAP,
  buildRemainingLaunchBudget,
  runDispatchTick,
} = await import('@/lib/orchestrator/scheduling');
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'o8-scheduling-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  writeFileSync(join(dir, 'README.md'), 'scheduling test\n');
  git('add', 'README.md');
  git('-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-m', 'init');
  return dir;
}

function commitChange(repoPath: string, fileName: string, body: string) {
  writeFileSync(join(repoPath, fileName), body);
  execFileSync('git', ['add', fileName], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-m', `change ${fileName}`], {
    cwd: repoPath,
    stdio: 'pipe',
  });
}

function packetFixture(
  repoPath: string,
  id: string,
  overrides: Partial<OrchestratorPacket> = {},
): OrchestratorPacket {
  return {
    id,
    referenceLabel: id.toUpperCase(),
    title: `packet ${id}`,
    summary: `packet ${id}`,
    status: 'queued',
    queueState: 'queued',
    releaseState: 'pending',
    runtime: 'codex',
    wave: 1,
    dependencyPacketIds: [],
    blockedReason: null,
    lane: null,
    review: null,
    workspaceTargetPath: repoPath,
    branchTarget: `inline/${id}`,
    ...overrides,
  } as OrchestratorPacket;
}

function missionFixture(repoPath: string, packets: OrchestratorPacket[]): OrchestratorMissionState {
  return {
    ...createEmptyOrchestratorMissionState(),
    missionId: `mission-${packets.map((packet) => packet.id).join('-')}`,
    repoPath,
    packets,
  };
}

describe('dispatch scheduling caps and waves', () => {
  beforeEach(() => {
    launchMock.calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });

  it('exports the configured global and runtime dispatch caps', () => {
    expect(MAX_PARALLEL_DISPATCHES).toBeGreaterThanOrEqual(1);
    expect(RUNTIME_PARALLEL_CAP.gemini).toBe(3);
  });

  it('subtracts active lane rows from the remaining launch budget', () => {
    const before = buildRemainingLaunchBudget();
    const codex = createLane({
      repoPath: '/tmp/o8-scheduling-active-repo',
      branch: `inline/active-codex-${Date.now()}`,
      runtime: 'codex',
    });
    const gemini = createLane({
      repoPath: '/tmp/o8-scheduling-active-repo',
      branch: `inline/active-gemini-${Date.now()}`,
      runtime: 'gemini',
    });
    setLaneStatus(codex.id, 'running', 'system', 'active');
    setLaneStatus(gemini.id, 'launching', 'system', 'active');

    const after = buildRemainingLaunchBudget();

    expect(after.maxLaunches).toBe(Math.max(0, before.maxLaunches - 2));
    expect(after.perRuntime?.gemini).toBe(Math.max(0, (before.perRuntime?.gemini ?? 0) - 1));
  });

  it('honors MAX_PARALLEL_DISPATCHES via the launch budget passed to the real tick', async () => {
    const repoPath = makeRepo();
    const packets = [1, 2, 3].map((index) => packetFixture(repoPath, `cap-${index}`));

    const next = await runDispatchTick(missionFixture(repoPath, packets), {
      launchBudget: { maxLaunches: Math.min(2, MAX_PARALLEL_DISPATCHES) },
    });

    expect(launchMock.calls.map((call) => call.packetId)).toHaveLength(Math.min(2, MAX_PARALLEL_DISPATCHES));
    expect(next.packets.filter((packet) => packet.status === 'launching')).toHaveLength(Math.min(2, MAX_PARALLEL_DISPATCHES));
    expect(next.packets.filter((packet) => packet.status === 'queued')).toHaveLength(3 - Math.min(2, MAX_PARALLEL_DISPATCHES));
  }, 20_000);

  it('honors the per-runtime launch budget for gemini dispatches', async () => {
    const repoPath = makeRepo();
    const geminiCap = RUNTIME_PARALLEL_CAP.gemini ?? 0;
    const packets = [1, 2, 3, 4].map((index) => packetFixture(repoPath, `gemini-${index}`, {
      runtime: 'gemini',
      workerRouting: { requestedRuntime: 'gemini' } as OrchestratorPacket['workerRouting'],
    }));

    const next = await runDispatchTick(missionFixture(repoPath, packets), {
      launchBudget: { maxLaunches: 10, perRuntime: { gemini: geminiCap } },
    });

    expect(launchMock.calls.map((call) => call.packetId)).toHaveLength(geminiCap);
    expect(launchMock.calls.every((call) => call.runtime === 'gemini')).toBe(true);
    expect(next.packets.filter((packet) => packet.status === 'launching')).toHaveLength(geminiCap);
    expect(next.packets.find((packet) => packet.id === 'gemini-4')?.status).toBe('queued');
  }, 20_000);

  it('dispatches only the released dependency wave before later packets', async () => {
    const repoPath = makeRepo();
    const first = packetFixture(repoPath, 'wave-first');
    const second = packetFixture(repoPath, 'wave-second', {
      dependencyPacketIds: ['wave-first'],
    });

    const next = await runDispatchTick(missionFixture(repoPath, [first, second]), {
      launchBudget: { maxLaunches: 10 },
    });

    expect(launchMock.calls.map((call) => call.packetId)).toEqual(['wave-first']);
    expect(next.packets.find((packet) => packet.id === 'wave-first')?.status).toBe('launching');
    expect(next.packets.find((packet) => packet.id === 'wave-second')?.status).toBe('queued');
  }, 20_000);

  it('skips recovery dispatches still inside the cooldown window', async () => {
    const repoPath = makeRepo();
    const packet = packetFixture(repoPath, 'cooldown', {
      status: 'recovering',
      recoveryCount: 1,
      lastRecoveryAt: new Date().toISOString(),
    });

    const next = await runDispatchTick(missionFixture(repoPath, [packet]), {
      launchBudget: { maxLaunches: 1 },
    });

    expect(launchMock.calls).toHaveLength(0);
    expect(next.packets[0].status).toBe('recovering');
  }, 20_000);

  it('salvages committed recovery work to review instead of redispatching', async () => {
    const repoPath = makeRepo();
    execFileSync('git', ['checkout', '-b', 'inline/recovery-committed'], { cwd: repoPath, stdio: 'pipe' });
    commitChange(repoPath, 'WORK.md', 'committed worker output\n');
    const lane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'inline/recovery-committed',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'recovery-committed',
    });
    setLaneStatus(lane.id, 'recovering', 'system', 'silent_exit_work_present');
    const packet = packetFixture(repoPath, 'recovery-committed', {
      status: 'recovering',
      recoveryCount: 0,
      lastRecoveryAt: new Date(Date.now() - 120_000).toISOString(),
      lane: {
        tileId: 'tile-recovery-committed',
        tabId: 'tab-recovery-committed',
        repoPath,
        worktreePath: repoPath,
        runtime: 'codex',
        laneId: lane.id,
        sessionKey: null,
        lastHeartbeatAt: null,
        lastEventAt: new Date().toISOString(),
        lastEventLabel: 'silent_exit_work_present',
      },
    });
    expect(await hasReviewableCompletionDiff(repoPath, 'main')).toBe(true);

    const next = await runDispatchTick(missionFixture(repoPath, [packet]), {
      launchBudget: { maxLaunches: 1 },
    });

    expect(launchMock.calls).toHaveLength(0);
    expect(next.packets[0].status).toBe('awaiting_review');
    expect(next.packets[0].lastEventLabel).toBe('session_recovery_autocommit');
  }, 20_000);
});
