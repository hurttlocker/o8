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

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));

const { createLane, findLaneByPacket, setLaneStatus } = await import('@/lib/lane/registry');
const { createEmptyOrchestratorMissionState, normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { readDispatchHaltState, setDispatchHaltState } = await import('@/lib/orchestrator/dispatch-halt');
const { hasReviewableCompletionDiff } = await import('@/lib/supervisor/completion-verification');
const {
  MAX_PARALLEL_DISPATCHES,
  MAX_LAUNCH_ATTEMPTS,
  RUNTIME_PARALLEL_CAP,
  buildRemainingLaunchBudget,
  getBootRecoveryLaunchBlocker,
  getDispatchBlocker,
  runDispatchTick,
} = await import('@/lib/orchestrator/scheduling');
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

function makeRepo(initialBranch = 'main'): string {
  const dir = mkdtempSync(join(tmpdir(), 'o8-scheduling-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', `--initial-branch=${initialBranch}`);
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
    setDispatchHaltState(false);
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

  it('carries outside launch provenance into the first supervisor announcement', async () => {
    const repoPath = makeRepo();
    const watchBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      watchBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response('{}', { status: 200 });
    }));
    const launchContext = {
      source: 'cli' as const,
      presentation: 'split' as const,
      repoContext: 'transient' as const,
      caller: 'outside terminal',
    };

    await runDispatchTick(missionFixture(repoPath, [packetFixture(repoPath, 'outside-worker', { launchContext })]), {
      launchBudget: { maxLaunches: 1 },
    });

    expect(watchBodies).toContainEqual(expect.objectContaining({ launchContext }));
  }, 20_000);

  it('uses a transient repository\'s real default branch when main does not exist', async () => {
    const repoPath = makeRepo('master');

    await runDispatchTick(missionFixture(repoPath, [packetFixture(repoPath, 'master-default')]), {
      launchBudget: { maxLaunches: 1 },
    });

    expect(findLaneByPacket('master-default')?.baseBranch).toBe('master');
    expect(launchMock.calls.map((call) => call.packetId)).toEqual(['master-default']);
  }, 20_000);

  it('honors an explicit per-runtime launch budget for Gemini', async () => {
    const repoPath = makeRepo();
    const cap = 3;
    const packets = [1, 2, 3, 4].map((index) => packetFixture(repoPath, `gemini-${index}`, {
      runtime: 'gemini',
      workerRouting: { requestedRuntime: 'gemini' } as OrchestratorPacket['workerRouting'],
    }));

    const next = await runDispatchTick(missionFixture(repoPath, packets), {
      launchBudget: { maxLaunches: 10, perRuntime: { gemini: cap } },
    });

    expect(launchMock.calls.map((call) => call.packetId)).toHaveLength(cap);
    expect(launchMock.calls.every((call) => call.runtime === 'gemini')).toBe(true);
    expect(next.packets.filter((packet) => packet.status === 'launching')).toHaveLength(cap);
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

  it('persists the dispatch halt gate and blocks launches until cleared', async () => {
    const repoPath = makeRepo();
    const packet = packetFixture(repoPath, 'halt-gate');

    setDispatchHaltState(true, 'test halt');
    expect(readDispatchHaltState()).toMatchObject({
      halted: true,
      reason: 'test halt',
    });

    const halted = await runDispatchTick(missionFixture(repoPath, [packet]), {
      launchBudget: { maxLaunches: 1 },
    });

    expect(launchMock.calls).toHaveLength(0);
    expect(halted.packets[0].status).toBe('queued');
    expect(readDispatchHaltState().halted).toBe(true);

    setDispatchHaltState(false);
    expect(readDispatchHaltState()).toMatchObject({
      halted: false,
      reason: null,
    });

    const resumed = await runDispatchTick(missionFixture(repoPath, [packet]), {
      launchBudget: { maxLaunches: 1 },
    });

    expect(launchMock.calls.map((call) => call.packetId)).toEqual(['halt-gate']);
    expect(resumed.packets[0].status).toBe('launching');
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

  it('caps launch/attach relaunches on the PACKET so a fresh lane cannot reset the budget', () => {
    const repoPath = makeRepo();
    // A launch that failed to attach: the lane fell back to idle with a
    // launch_error label, which getDispatchBlocker normally re-admits for retry.
    const launchFailedLane = {
      tileId: 'tile-thrash',
      tabId: 'tab-thrash',
      repoPath,
      worktreePath: repoPath,
      runtime: 'codex' as const,
      laneId: 'lane-thrash',
      lastEventLabel: 'launch_error',
    };
    const base = packetFixture(repoPath, 'launch-thrash', {
      status: 'queued',
      queueState: 'queued',
      lane: launchFailedLane,
    });

    // Below the cap: the launch_error retry path re-admits the packet (null).
    expect(
      getDispatchBlocker({ ...base, launchAttempts: MAX_LAUNCH_ATTEMPTS - 1 }, []),
    ).toBeNull();

    // At the cap: blocked — even though it's a fresh lane, the packet-scoped
    // counter survived the redispatch and stops the launching<->idle thrash.
    expect(
      getDispatchBlocker({ ...base, launchAttempts: MAX_LAUNCH_ATTEMPTS }, []),
    ).toMatch(/Launch attempts exceeded/);
  });
});

describe('boot recovery launch guard (#1460)', () => {
  beforeEach(() => {
    launchMock.calls.length = 0;
    setDispatchHaltState(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });

  const guardedPacket = (overrides: Partial<OrchestratorPacket> = {}) =>
    packetFixture('/tmp/o8-boot-guard', 'boot-guard', {
      status: 'queued',
      queueState: 'queued',
      releaseState: 'pending',
      workerRouting: undefined,
      ...overrides,
    });

  it('allows a live queued packet with a pinned runtime', () => {
    expect(getBootRecoveryLaunchBlocker({
      missionLive: true,
      packet: guardedPacket(),
      pinnedRuntime: 'claude-code',
    })).toBeNull();
  });

  it('skips archived missions', () => {
    expect(getBootRecoveryLaunchBlocker({
      missionArchived: true,
      missionLive: true,
      packet: guardedPacket(),
      pinnedRuntime: 'codex',
    })).toBe('mission is not live');
  });

  it('skips unpinned runtime recovery', () => {
    expect(getBootRecoveryLaunchBlocker({
      missionLive: true,
      packet: guardedPacket(),
      pinnedRuntime: null,
    })).toBe('runtime is not pinned');
  });

  it('does not treat normalized selectedRuntime as an explicit boot pin', () => {
    expect(getBootRecoveryLaunchBlocker({
      missionLive: true,
      packet: guardedPacket({
        runtime: 'claude-code',
        dispatchRuntimePin: null,
      }),
      pinnedRuntime: null,
    })).toBe('runtime is not pinned');
  });

  it('blocks a normalized queued never-launched claude-code packet through the real dispatch tick', async () => {
    const repoPath = makeRepo();
    const stalePacket = packetFixture(repoPath, 'boot-never-launched', {
      runtime: 'claude-code',
      workerRouting: undefined,
      dispatchRuntimePin: undefined,
    });
    const normalized = normalizeOrchestratorMissionState(missionFixture(repoPath, [stalePacket]));

    expect(normalized.packets[0].workerRouting?.requestedRuntime).toBe('claude-code');
    expect(normalized.packets[0].dispatchRuntimePin).toBeNull();

    const next = await runDispatchTick(normalized, {
      launchBudget: { maxLaunches: 1 },
      enforceBootRecoveryGuard: true,
    });

    expect(launchMock.calls).toHaveLength(0);
    expect(next.packets[0].status).toBe('queued');
    expect(next.packets[0].dispatchRuntimePin).toBeNull();
  }, 20_000);

  it('skips review states that no longer expect a worker', () => {
    expect(getBootRecoveryLaunchBlocker({
      missionLive: true,
      packet: guardedPacket({ status: 'awaiting_review' }),
      pinnedRuntime: 'codex',
    })).toBe('lane state does not expect a worker (awaiting_review)');
  });
});
