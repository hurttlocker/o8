import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-mission-registry-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;

const launchMock = vi.hoisted(() => ({
  calls: [] as Array<{ packetId?: string; repoPath: string }>,
}));
const retrySalvageProbeGate = vi.hoisted(() => ({
  entered: null as (() => void) | null,
  wait: null as Promise<void> | null,
}));
const retrySalvageKillSeam = vi.hoisted(() => ({
  afterConfirmed: null as (() => void | Promise<void>) | null,
  calls: 0,
  forceConfirmed: false,
}));
const tempDirs: string[] = [];

vi.mock('@/lib/runtime/actions', () => ({
  launchRuntimeSurface: vi.fn(async (input: { packetId?: string; repoPath: string }) => {
    launchMock.calls.push({ packetId: input.packetId, repoPath: input.repoPath });
    return {
      ok: true,
      surfaceId: `codex-owned:${input.packetId ?? launchMock.calls.length}`,
      note: 'mock runtime launched',
      worktree: { path: input.repoPath },
    };
  }),
}));

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));

vi.mock('@/lib/lane/no-changes-produced', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/no-changes-produced')>();
  return {
    ...actual,
    probeNoChangesProduced: vi.fn(async (...args: Parameters<typeof actual.probeNoChangesProduced>) => {
      if (retrySalvageProbeGate.wait) {
        retrySalvageProbeGate.entered?.();
        await retrySalvageProbeGate.wait;
      }
      return actual.probeNoChangesProduced(...args);
    }),
  };
});

vi.mock('@/lib/lane/reap-sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/reap-sessions')>();
  return {
    ...actual,
    archiveLaneSessions: vi.fn(async (lanes: Parameters<typeof actual.archiveLaneSessions>[0]) => {
      const outcomes = lanes.flatMap((lane) => lane.sessionKey?.includes('-owned:') ? [{
        laneId: lane.id,
        sessionKey: lane.sessionKey,
        runtime: lane.runtime,
        archived: true,
        note: 'archived by test fixture',
      }] : []);
      return {
        targeted: outcomes.length,
        archived: outcomes.length,
        outcomes,
        failures: [],
      };
    }),
    killLaneSessionsConfirmed: vi.fn(async (...args: Parameters<typeof actual.killLaneSessionsConfirmed>) => {
      retrySalvageKillSeam.calls += 1;
      const lanes = args[0];
      const outcomes = retrySalvageKillSeam.forceConfirmed
        ? lanes.flatMap((lane) => lane.sessionKey ? [{
            laneId: lane.id,
            sessionKey: lane.sessionKey,
            runtime: lane.runtime,
            confirmed: true,
            alreadyDead: false,
            stages: [{ stage: 'interrupt' as const, confirmed: true }],
            note: 'confirmed by test kill seam',
          }] : [])
        : await actual.killLaneSessionsConfirmed(...args);
      await retrySalvageKillSeam.afterConfirmed?.();
      return outcomes;
    }),
  };
});

vi.mock('@/lib/lane/owned-session-liveness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/owned-session-liveness')>();
  return {
    ...actual,
    probeLaneSessionAlive: vi.fn(async (...args: Parameters<typeof actual.probeLaneSessionAlive>) => (
      retrySalvageKillSeam.forceConfirmed ? false : actual.probeLaneSessionAlive(...args)
    )),
  };
});

function createTempRepo() {
  const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-mission-registry-repo-'));
  tempDirs.push(repoPath);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  writeFileSync(join(repoPath, 'README.md'), 'mission registry test\n');
  git('add', 'README.md');
  git('-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '-m', 'init');
  return repoPath;
}

function commitWorkerResult(repoPath: string, branch: string, filename = 'WORK.md') {
  execFileSync('git', ['checkout', '-b', branch], { cwd: repoPath, stdio: 'pipe' });
  writeFileSync(join(repoPath, filename), 'committed worker result\n');
  execFileSync('git', ['add', filename], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', [
    '-c', 'user.email=test@o8.test',
    '-c', 'user.name=o8-test',
    'commit', '-m', 'worker result',
  ], { cwd: repoPath, stdio: 'pipe' });
}

function textContent(result: { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> }) {
  return result.content.find((entry) => entry.type === 'text')?.text ?? '';
}

function parseMissionResult(result: { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> }) {
  return JSON.parse(textContent(result)) as {
    missionId: string;
    packets: Array<{ id: string; title: string; wave: number }>;
  };
}

function parseJsonResult<T>(result: { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> }) {
  return JSON.parse(textContent(result)) as T;
}

function apiResponse(factory: () => Promise<unknown>) {
  return factory()
    .then((result) => new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    .catch((error) => new Response(JSON.stringify({
      ok: false,
      error: { message: error instanceof Error ? error.message : String(error) },
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    }));
}

function stubMissionApiFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlText = String(url);
    if (urlText.includes('/supervisor/watch') || urlText.includes('/internal/realtime')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = JSON.parse(String(init?.body ?? '{}'));
    if (urlText.includes('/api/orchestrator/create-mission')) {
      return apiResponse(async () => {
        const { createMission } = await import('@/lib/orchestrator/operator-mission-service/mission');
        return createMission(body as Parameters<typeof createMission>[0]);
      });
    }
    if (urlText.includes('/api/orchestrator/dispatch')) {
      return apiResponse(async () => {
        const { dispatchMission } = await import('@/lib/orchestrator/operator-mission-service/mission');
        return dispatchMission(body as Parameters<typeof dispatchMission>[0]);
      });
    }
    if (urlText.includes('/api/orchestrator/reset-packet')) {
      return apiResponse(async () => {
        const { resetPacket } = await import('@/lib/orchestrator/operator-mission-service/reset');
        return resetPacket(body as Parameters<typeof resetPacket>[0]);
      });
    }
    if (urlText.includes('/api/orchestrator/rerun-with-feedback')) {
      return apiResponse(async () => {
        const { rerunWithFeedback } = await import('@/lib/orchestrator/operator-mission-service/rerun-with-feedback');
        return rerunWithFeedback(body as Parameters<typeof rerunWithFeedback>[0]);
      });
    }

    return new Response(JSON.stringify({ ok: false, error: { message: `Unhandled test URL: ${urlText}` } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }));
}

async function createInlineMission(title: string, repoPath: string) {
  const { handleCreateMission } = await import('@/lib/mcp/operator-handlers/mission');
  return parseMissionResult(await handleCreateMission({
    issues_inline: [{ title, body: `${title} body` }],
    repoPath,
    runtime: 'codex',
    dispatch: false,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  launchMock.calls = [];
  retrySalvageProbeGate.entered = null;
  retrySalvageProbeGate.wait = null;
  retrySalvageKillSeam.afterConfirmed = null;
  retrySalvageKillSeam.calls = 0;
  retrySalvageKillSeam.forceConfirmed = false;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('headless mission registry dispatch', () => {
  it('dispatches a non-current mission packet after a newer mission becomes current', async () => {
    const repoPath = createTempRepo();
    stubMissionApiFetch();

    const first = await createInlineMission('registry mission A', repoPath);
    const second = await createInlineMission('registry mission B', repoPath);

    const { runHeadlessSprintTick } = await import('@/lib/orchestrator/headless-loop');
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const { findLaneByPacket } = await import('@/lib/lane/registry');

    expect(readOrchestratorControlPlaneState().missionId).toBe(second.missionId);
    await runHeadlessSprintTick();

    const firstPacketId = first.packets[0]?.id;
    expect(firstPacketId).toBeTruthy();
    expect(findLaneByPacket(firstPacketId!)?.id).toMatch(/^lane-/);
    expect(readOrchestratorControlPlaneState().missionId).toBe(second.missionId);
    expect(launchMock.calls.some((call) => call.packetId === firstPacketId)).toBe(true);
  }, 20_000);

  it('inserts the outgoing current snapshot when its registry row is missing', async () => {
    const repoPath = createTempRepo();
    stubMissionApiFetch();
    const first = await createInlineMission('missing outgoing registry row', repoPath);
    const { getSqlite } = await import('@/lib/db');
    getSqlite().prepare('DELETE FROM missions WHERE id = ?').run(first.missionId);

    const second = await createInlineMission('replacement current mission', repoPath);

    const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    expect(readOrchestratorControlPlaneState().missionId).toBe(second.missionId);
    expect(readMissionRegistryEntry(first.missionId, { includeArchived: true })?.mission).toMatchObject({
      missionId: first.missionId,
      packets: [expect.objectContaining({ id: first.packets[0]!.id })],
    });
  });

  it('dispatch_mission addresses a non-current missionId through the real MCP handler', async () => {
    const repoPath = createTempRepo();
    stubMissionApiFetch();
    const first = await createInlineMission('registry mcp dispatch A', repoPath);
    const second = await createInlineMission('registry mcp dispatch B', repoPath);

    const { handleDispatchMission } = await import('@/lib/mcp/operator-handlers/mission');
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const { findLaneByPacket } = await import('@/lib/lane/registry');

    expect(readOrchestratorControlPlaneState().missionId).toBe(second.missionId);
    const result = parseJsonResult<{ dispatched?: number }>(await handleDispatchMission({ missionId: first.missionId }));

    const firstPacketId = first.packets[0]?.id;
    expect(firstPacketId).toBeTruthy();
    expect(result.dispatched).toBe(1);
    expect(findLaneByPacket(firstPacketId!)?.id).toMatch(/^lane-/);
    expect(readOrchestratorControlPlaneState().missionId).toBe(second.missionId);
  }, 20_000);

  it('retry_packet supersedes the durable review while resetting a non-current registry packet', async () => {
    const repoPath = createTempRepo();
    stubMissionApiFetch();
    const first = await createInlineMission('registry mcp retry A', repoPath);
    const second = await createInlineMission('registry mcp retry B', repoPath);

    const packetId = first.packets[0]?.id;
    expect(packetId).toBeTruthy();
    const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    const durablePacket = readMissionRegistryEntry(first.missionId, { includeArchived: true })
      ?.mission.packets.find((candidate) => candidate.id === packetId);
    const { createLane, findLaneByPacket, getLane } = await import('@/lib/lane/registry');
    const retiredLane = createLane({
      repoPath,
      branch: durablePacket!.branchTarget,
      runtime: 'codex',
      packetId: packetId!,
    });
    expect(retiredLane?.id).toMatch(/^lane-/);
    const { listApprovalsForContext, recordOrchestratorReview } = await import('@/lib/approvals/store');
    recordOrchestratorReview(packetId!, {
      approved: true,
      findings: [],
      reviewedHeadSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim(),
    });
    const { handleRetryPacket } = await import('@/lib/mcp/operator-handlers/mission');
    const retryResult = parseJsonResult<{ reset?: boolean; referenceLabel?: string }>(await handleRetryPacket({
      packetId: packetId!,
      reason: 'retry non-current packet',
    }));

    const { readMissionRegistryEntry: readResetMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const packet = readResetMissionRegistryEntry(first.missionId, { includeArchived: true })?.mission.packets
      .find((candidate) => candidate.id === packetId);

    expect(retryResult.reset).toBe(true);
    expect(retryResult.referenceLabel).toBe('inline-1');
    expect(packet?.status).toBe('draft');
    expect(packet?.queueState).toBe('held');
    expect(packet?.storageAdmissionEpoch).toBe(2);
    expect(findLaneByPacket(packetId!)).toBeNull();
    expect(getLane(retiredLane.id)?.packetId).toBeFalsy();
    expect(readOrchestratorControlPlaneState().missionId).toBe(second.missionId);
    expect(listApprovalsForContext({ packetId }).find((approval) => (
      approval.toolName === 'orchestrator_review'
    ))?.args).toMatchObject({
      reviewSuperseded: true,
      reviewSupersededReason: 'Superseded by reset_packet.',
    });
  });

  it('retry_packet re-arms an archived registry packet and dispatch_mission relaunches it', async () => {
    const repoPath = createTempRepo();
    stubMissionApiFetch();
    const first = await createInlineMission('registry archived retry A', repoPath);
    const second = await createInlineMission('registry archived retry B', repoPath);
    const packetId = first.packets[0]?.id;
    expect(packetId).toBeTruthy();

    const { handleDispatchMission, handleRetryPacket } = await import('@/lib/mcp/operator-handlers/mission');
    const initialDispatch = parseJsonResult<{ dispatched?: number }>(await handleDispatchMission({ missionId: first.missionId }));
    expect(initialDispatch.dispatched).toBe(1);

    const { archiveLane, findLaneByPacket, getLane } = await import('@/lib/lane/registry');
    const oldLane = findLaneByPacket(packetId!);
    expect(oldLane?.id).toMatch(/^lane-/);
    archiveLane(oldLane!.id, 'system');

    const { readMissionRegistryEntry, withMissionRegistryState } = await import('@/lib/orchestrator/mission-registry');
    await withMissionRegistryState(first.missionId, (current) => {
      const packet = current.packets.find((candidate) => candidate.id === packetId);
      expect(packet).toBeTruthy();
      packet!.status = 'archived';
      packet!.queueState = 'queued';
      packet!.archivedAt = '2026-07-18T12:00:00.000Z';
      return { state: current, result: null };
    });

    const retryResult = parseJsonResult<{ reset?: boolean }>(await handleRetryPacket({
      packetId: packetId!,
      reason: 'retry archived packet',
    }));
    const resetPacket = readMissionRegistryEntry(first.missionId, { includeArchived: true })?.mission.packets
      .find((candidate) => candidate.id === packetId);
    expect(retryResult.reset).toBe(true);
    expect(resetPacket).toMatchObject({
      status: 'draft',
      queueState: 'held',
      archivedAt: null,
      lane: null,
      storageAdmissionEpoch: 2,
    });
    expect(getLane(oldLane!.id)?.packetId).toBeFalsy();

    const redispatch = parseJsonResult<{
      dispatched?: number;
      skipped?: Array<{ packetId: string; reason: string }>;
    }>(await handleDispatchMission({ missionId: first.missionId }));
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const relaunched = readMissionRegistryEntry(first.missionId, { includeArchived: true })?.mission.packets
      .find((candidate) => candidate.id === packetId);
    expect(redispatch.dispatched).toBe(1);
    expect(redispatch.skipped).toEqual([]);
    expect(relaunched?.status).toBe('launching');
    expect(relaunched?.queueState).toBe('queued');
    expect(relaunched?.lane?.laneId).toMatch(/^lane-/);
    expect(readOrchestratorControlPlaneState().missionId).toBe(second.missionId);
  }, 20_000);

  it('retry_packet salvages a clean committed result into review without relaunching', async () => {
    const repoPath = createTempRepo();
    stubMissionApiFetch();
    const first = await createInlineMission('registry committed retry A', repoPath);
    await createInlineMission('registry committed retry B', repoPath);
    const packetId = first.packets[0]?.id;
    expect(packetId).toBeTruthy();

    const { handleDispatchMission, handleRetryPacket } = await import('@/lib/mcp/operator-handlers/mission');
    const initialDispatch = parseJsonResult<{ dispatched?: number }>(await handleDispatchMission({ missionId: first.missionId }));
    expect(initialDispatch.dispatched).toBe(1);

    const { findLaneByPacket, getLane, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
    const oldLane = findLaneByPacket(packetId!);
    expect(oldLane?.worktreePath).toBe(repoPath);
    commitWorkerResult(repoPath, oldLane!.branch);
    updateLane(oldLane!.id, { sessionKey: null });
    setLaneStatus(oldLane!.id, 'failed', 'system', 'zero_diff_failed');
    const { probeNoChangesProduced } = await import('@/lib/lane/no-changes-produced');
    await expect(probeNoChangesProduced(repoPath, oldLane!.baseBranch)).resolves.toMatchObject({
      commitsAhead: 1,
      statusPorcelain: '',
    });

    const launchCountBeforeRetry = launchMock.calls.length;
    const retryResult = parseJsonResult<{
      reset?: boolean;
      salvaged?: boolean;
      laneId?: string;
    }>(await handleRetryPacket({
      packetId: packetId!,
      reason: 'recover committed timing-drift result',
    }));

    const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    const packet = readMissionRegistryEntry(first.missionId, { includeArchived: true })?.mission.packets
      .find((candidate) => candidate.id === packetId);
    const reviewLane = retryResult.laneId ? getLane(retryResult.laneId) : null;

    expect(retryResult).toMatchObject({ reset: false, salvaged: true });
    expect(reviewLane).toMatchObject({
      status: 'reviewing',
      worktreePath: repoPath,
      lastEventLabel: 'retry_salvaged_work',
    });
    expect(getLane(oldLane!.id)).toMatchObject({
      status: 'archived',
      packetId: '',
      worktreePath: null,
    });
    expect(packet).toMatchObject({
      status: 'awaiting_review',
      lastEventLabel: 'retry_salvaged_work',
      lane: {
        laneId: retryResult.laneId,
        worktreePath: repoPath,
        sessionKey: null,
      },
    });

    const redispatch = parseJsonResult<{ dispatched?: number }>(await handleDispatchMission({ missionId: first.missionId }));
    expect(redispatch.dispatched).toBe(0);
    expect(launchMock.calls).toHaveLength(launchCountBeforeRetry);
  }, 20_000);

  it('salvages committed work for the active mission through the current control-plane lock', async () => {
    const repoPath = createTempRepo();
    stubMissionApiFetch();
    const mission = await createInlineMission('current committed retry', repoPath);
    const packetId = mission.packets[0]!.id;
    const { handleDispatchMission, handleRetryPacket } = await import('@/lib/mcp/operator-handlers/mission');
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    expect(readOrchestratorControlPlaneState().missionId).toBe(mission.missionId);
    expect(parseJsonResult<{ dispatched?: number }>(await handleDispatchMission({ missionId: mission.missionId })).dispatched).toBe(1);

    const { findLaneByPacket, getLane, setLaneStatus } = await import('@/lib/lane/registry');
    const oldLane = findLaneByPacket(packetId)!;
    const oldSessionKey = oldLane.sessionKey;
    commitWorkerResult(repoPath, oldLane.branch);
    retrySalvageKillSeam.forceConfirmed = true;
    setLaneStatus(oldLane.id, 'failed', 'system', 'zero_diff_failed');
    const launchCountBeforeRetry = launchMock.calls.length;
    const retry = parseJsonResult<{ reset?: boolean; salvaged?: boolean; laneId?: string }>(await handleRetryPacket({ packetId }));

    const current = readOrchestratorControlPlaneState();
    const packet = current.packets.find((candidate) => candidate.id === packetId);
    expect(retry).toMatchObject({ reset: false, salvaged: true });
    expect(packet).toMatchObject({
      status: 'awaiting_review',
      lane: { laneId: retry.laneId, worktreePath: repoPath },
    });
    expect(getLane(retry.laneId!)).toMatchObject({
      id: retry.laneId,
      packetId,
      status: 'reviewing',
      worktreePath: repoPath,
    });
    expect(getLane(oldLane.id)).toMatchObject({
      status: 'archived',
      packetId: '',
      sessionKey: oldSessionKey,
      worktreePath: null,
    });
    expect(parseJsonResult<{ dispatched?: number }>(await handleDispatchMission({ missionId: mission.missionId })).dispatched).toBe(0);
    expect(launchMock.calls).toHaveLength(launchCountBeforeRetry);
  }, 20_000);

  it('does not salvage an older committed lane when the guarded live lane has no result', async () => {
    const repoPath = createTempRepo();
    const staleWorktree = createTempRepo();
    stubMissionApiFetch();
    const first = await createInlineMission('registry exact lane retry A', repoPath);
    await createInlineMission('registry exact lane retry B', repoPath);
    const packetId = first.packets[0]!.id;
    const { handleDispatchMission, handleRetryPacket } = await import('@/lib/mcp/operator-handlers/mission');
    expect(parseJsonResult<{ dispatched?: number }>(await handleDispatchMission({ missionId: first.missionId })).dispatched).toBe(1);

    const { createLane, findLaneByPacket, getLane, listLanes, setLaneStatus } = await import('@/lib/lane/registry');
    const currentLane = findLaneByPacket(packetId)!;
    const staleBranch = `${currentLane.branch}-stale`;
    commitWorkerResult(staleWorktree, staleBranch);
    const staleLane = createLane({
      repoPath,
      projectId: currentLane.projectId,
      branch: staleBranch,
      baseBranch: currentLane.baseBranch,
      runtime: currentLane.runtime,
      label: `${currentLane.label} stale`,
      packetId,
      ownership: currentLane.ownership,
      worktreePath: staleWorktree,
      actor: 'system',
    });
    setLaneStatus(staleLane.id, 'failed', 'system', 'older_committed_result');
    setLaneStatus(currentLane.id, 'running', 'system', 'current_live_generation');

    const retry = parseJsonResult<{ reset?: boolean; salvaged?: boolean }>(await handleRetryPacket({ packetId }));
    expect(retry.reset).toBe(true);
    expect(retry.salvaged).not.toBe(true);
    expect(listLanes().some((lane) => lane.packetId === packetId && lane.status === 'reviewing')).toBe(false);
    expect(getLane(staleLane.id)).toMatchObject({ status: 'archived', packetId: '', worktreePath: null });
    expect(execFileSync('git', ['rev-list', '--count', 'main..HEAD'], { cwd: staleWorktree, encoding: 'utf8' }).trim()).toBe('1');
  }, 20_000);

  it('does not promote a worktree dirtied during the confirmed kill seam', async () => {
    const repoPath = createTempRepo();
    stubMissionApiFetch();
    const first = await createInlineMission('registry post-kill retry A', repoPath);
    await createInlineMission('registry post-kill retry B', repoPath);
    const packetId = first.packets[0]!.id;
    const { handleDispatchMission, handleRetryPacket } = await import('@/lib/mcp/operator-handlers/mission');
    expect(parseJsonResult<{ dispatched?: number }>(await handleDispatchMission({ missionId: first.missionId })).dispatched).toBe(1);

    const { findLaneByPacket, listLanes, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
    const lane = findLaneByPacket(packetId)!;
    commitWorkerResult(repoPath, lane.branch);
    const sessionKey = 'opencode:test-kill-seam';
    updateLane(lane.id, { sessionKey });
    setLaneStatus(lane.id, 'failed', 'system', 'zero_diff_failed');
    const { withMissionRegistryState, readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    await withMissionRegistryState(first.missionId, (state) => {
      const packet = state.packets.find((candidate) => candidate.id === packetId)!;
      packet.lane = { ...packet.lane!, sessionKey };
      return { state, result: null };
    });
    retrySalvageKillSeam.forceConfirmed = true;
    retrySalvageKillSeam.afterConfirmed = () => writeFileSync(join(repoPath, 'DIRTY.md'), 'late worker write\n');

    const retry = parseJsonResult<{ reset?: boolean; salvaged?: boolean }>(await handleRetryPacket({ packetId }));
    const packet = readMissionRegistryEntry(first.missionId, { includeArchived: true })?.mission.packets
      .find((candidate) => candidate.id === packetId);
    expect(retry.reset).toBe(true);
    expect(retry.salvaged).not.toBe(true);
    expect(retrySalvageKillSeam.calls).toBeGreaterThan(0);
    expect(packet).toMatchObject({ status: 'draft', queueState: 'held', lane: null });
    expect(listLanes().some((candidate) => candidate.packetId === packetId && candidate.status === 'reviewing')).toBe(false);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf8' })).toContain('DIRTY.md');
  }, 20_000);

  it('holds persisted retry salvage against dispatch and refuses to overwrite a newer generation', async () => {
    const repoPath = createTempRepo();
    stubMissionApiFetch();
    const first = await createInlineMission('registry concurrent retry A', repoPath);
    await createInlineMission('registry concurrent retry B', repoPath);
    const packetId = first.packets[0]?.id;
    expect(packetId).toBeTruthy();

    const { handleDispatchMission, handleRetryPacket } = await import('@/lib/mcp/operator-handlers/mission');
    const initialDispatch = parseJsonResult<{ dispatched?: number }>(await handleDispatchMission({ missionId: first.missionId }));
    expect(initialDispatch.dispatched).toBe(1);

    const {
      archiveLane,
      createLane,
      findLaneByPacket,
      getLane,
      setLaneStatus,
      updateLane,
    } = await import('@/lib/lane/registry');
    const oldLane = findLaneByPacket(packetId!);
    expect(oldLane?.worktreePath).toBe(repoPath);
    commitWorkerResult(repoPath, oldLane!.branch);
    updateLane(oldLane!.id, { sessionKey: null });
    setLaneStatus(oldLane!.id, 'failed', 'system', 'zero_diff_failed');

    let releaseProbe!: () => void;
    let markProbeEntered!: () => void;
    const probeEntered = new Promise<void>((resolve) => {
      markProbeEntered = resolve;
    });
    retrySalvageProbeGate.entered = markProbeEntered;
    retrySalvageProbeGate.wait = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });

    const launchCountBeforeRetry = launchMock.calls.length;
    const retryPromise = handleRetryPacket({
      packetId: packetId!,
      reason: 'recover committed timing-drift result',
    });
    await probeEntered;

    const { readMissionRegistryEntry, withMissionRegistryState } = await import('@/lib/orchestrator/mission-registry');
    const held = readMissionRegistryEntry(first.missionId, { includeArchived: true })?.mission.packets
      .find((candidate) => candidate.id === packetId);
    expect(held).toMatchObject({
      queueState: 'held',
      operatorStopped: true,
      releaseStatePayload: { source: expect.stringMatching(/^retry_salvage:/) },
    });

    const concurrentDispatch = parseJsonResult<{ dispatched?: number }>(await handleDispatchMission({
      missionId: first.missionId,
    }));
    expect(concurrentDispatch.dispatched).toBe(0);
    expect(launchMock.calls).toHaveLength(launchCountBeforeRetry);

    const nextLane = createLane({
      repoPath: oldLane!.repoPath,
      projectId: oldLane!.projectId,
      branch: `${oldLane!.branch}-next`,
      baseBranch: oldLane!.baseBranch,
      runtime: oldLane!.runtime,
      label: `${oldLane!.label} next`,
      packetId: packetId!,
      ownership: oldLane!.ownership,
      worktreePath: repoPath,
      actor: 'system',
    });
    setLaneStatus(nextLane.id, 'running', 'system', 'concurrent_generation');
    await withMissionRegistryState(first.missionId, (current) => {
      const packet = current.packets.find((candidate) => candidate.id === packetId);
      expect(packet?.lane).toBeTruthy();
      packet!.status = 'running';
      packet!.queueState = 'queued';
      packet!.operatorStopped = false;
      packet!.blockedReason = null;
      packet!.releaseStatePayload = null;
      packet!.lastEventLabel = 'concurrent_generation';
      packet!.lane = {
        ...packet!.lane!,
        laneId: nextLane.id,
        sessionKey: null,
        worktreePath: repoPath,
        lastEventLabel: 'concurrent_generation',
      };
      return { state: current, result: null };
    });

    retrySalvageProbeGate.wait = null;
    releaseProbe();
    const retryResult = parseJsonResult<{ reset?: boolean; salvaged?: boolean; note?: string }>(await retryPromise);
    expect(retryResult).toMatchObject({
      reset: false,
      salvaged: false,
      note: expect.stringContaining('changed while retry salvage was probing'),
    });

    const preserved = readMissionRegistryEntry(first.missionId, { includeArchived: true })?.mission.packets
      .find((candidate) => candidate.id === packetId);
    expect(preserved).toMatchObject({
      status: 'running',
      queueState: 'queued',
      lastEventLabel: 'concurrent_generation',
      lane: { laneId: nextLane.id },
    });
    expect(preserved?.operatorStopped).not.toBe(true);
    expect(getLane(oldLane!.id)).toMatchObject({
      packetId,
      status: 'failed',
      worktreePath: repoPath,
    });
    expect(getLane(nextLane.id)).toMatchObject({
      packetId,
      status: 'running',
      worktreePath: repoPath,
    });
    expect(launchMock.calls).toHaveLength(launchCountBeforeRetry);
    archiveLane(oldLane!.id, 'system');
    archiveLane(nextLane.id, 'system');
  }, 20_000);

  it('preserves a newer generation when retry salvage finds no committed candidate', async () => {
    const repoPath = createTempRepo();
    stubMissionApiFetch();
    const first = await createInlineMission('registry empty retry A', repoPath);
    await createInlineMission('registry empty retry B', repoPath);
    const packetId = first.packets[0]?.id;
    expect(packetId).toBeTruthy();

    const { handleDispatchMission, handleRetryPacket } = await import('@/lib/mcp/operator-handlers/mission');
    expect(parseJsonResult<{ dispatched?: number }>(await handleDispatchMission({
      missionId: first.missionId,
    })).dispatched).toBe(1);

    const {
      archiveLane,
      createLane,
      findLaneByPacket,
      getLane,
      setLaneStatus,
    } = await import('@/lib/lane/registry');
    const oldLane = findLaneByPacket(packetId!);
    expect(oldLane?.worktreePath).toBe(repoPath);

    let releaseProbe!: () => void;
    let markProbeEntered!: () => void;
    const probeEntered = new Promise<void>((resolve) => {
      markProbeEntered = resolve;
    });
    retrySalvageProbeGate.entered = markProbeEntered;
    retrySalvageProbeGate.wait = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });

    const retryPromise = handleRetryPacket({
      packetId: packetId!,
      reason: 'retry clean zero-change result',
    });
    await probeEntered;

    const nextLane = createLane({
      repoPath: oldLane!.repoPath,
      projectId: oldLane!.projectId,
      branch: `${oldLane!.branch}-next-empty`,
      baseBranch: oldLane!.baseBranch,
      runtime: oldLane!.runtime,
      label: `${oldLane!.label} next empty`,
      packetId: packetId!,
      ownership: oldLane!.ownership,
      worktreePath: repoPath,
      actor: 'system',
    });
    setLaneStatus(nextLane.id, 'running', 'system', 'concurrent_empty_generation');
    const { readMissionRegistryEntry, withMissionRegistryState } = await import('@/lib/orchestrator/mission-registry');
    await withMissionRegistryState(first.missionId, (current) => {
      const packet = current.packets.find((candidate) => candidate.id === packetId)!;
      packet.status = 'running';
      packet.queueState = 'queued';
      packet.operatorStopped = false;
      packet.blockedReason = null;
      packet.releaseStatePayload = null;
      packet.lastEventLabel = 'concurrent_empty_generation';
      packet.lane = {
        ...packet.lane!,
        laneId: nextLane.id,
        sessionKey: null,
        worktreePath: repoPath,
        lastEventLabel: 'concurrent_empty_generation',
      };
      return { state: current, result: null };
    });

    retrySalvageProbeGate.wait = null;
    releaseProbe();
    const retry = parseJsonResult<{ reset?: boolean; salvaged?: boolean; note?: string }>(await retryPromise);
    expect(retry).toMatchObject({
      reset: false,
      salvaged: false,
      note: expect.stringContaining('newer generation was left untouched'),
    });
    expect(readMissionRegistryEntry(first.missionId, { includeArchived: true })?.mission.packets
      .find((candidate) => candidate.id === packetId)).toMatchObject({
      status: 'running',
      queueState: 'queued',
      lane: { laneId: nextLane.id },
    });
    expect(getLane(oldLane!.id)).toMatchObject({ packetId, status: oldLane!.status });
    expect(getLane(nextLane.id)).toMatchObject({ packetId, status: 'running' });
    archiveLane(oldLane!.id, 'system');
    archiveLane(nextLane.id, 'system');
  }, 20_000);

  it('dispatch_mission reports an archived terminal-lane skip with a retry action', async () => {
    const repoPath = createTempRepo();
    stubMissionApiFetch();
    const first = await createInlineMission('registry terminal skip A', repoPath);
    const second = await createInlineMission('registry terminal skip B', repoPath);
    const packetId = first.packets[0]?.id;
    expect(packetId).toBeTruthy();

    const { handleDispatchMission } = await import('@/lib/mcp/operator-handlers/mission');
    const initialDispatch = parseJsonResult<{ dispatched?: number }>(await handleDispatchMission({ missionId: first.missionId }));
    expect(initialDispatch.dispatched).toBe(1);

    const { archiveLane, findLaneByPacket } = await import('@/lib/lane/registry');
    const lane = findLaneByPacket(packetId!);
    expect(lane?.id).toMatch(/^lane-/);
    archiveLane(lane!.id, 'system');

    const result = parseJsonResult<{
      dispatched?: number;
      skipped?: Array<{
        packetId: string;
        reason: string;
        suggestedAction?: string;
      }>;
    }>(await handleDispatchMission({ missionId: first.missionId }));
    const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const terminalPacket = readMissionRegistryEntry(first.missionId, { includeArchived: true })?.mission.packets
      .find((candidate) => candidate.id === packetId);

    expect(result.dispatched).toBe(0);
    expect(result.skipped).toEqual([expect.objectContaining({
      packetId,
      reason: 'archived',
      suggestedAction: 'retry_packet',
    })]);
    expect(terminalPacket?.status).toBe('archived');
    expect(terminalPacket?.queueState).toBe('held');
    expect(readOrchestratorControlPlaneState().missionId).toBe(second.missionId);
  }, 20_000);

  it('rerun_with_feedback supersedes the durable review before relaunching a non-current registry packet', async () => {
    const repoPath = createTempRepo();
    stubMissionApiFetch();
    const first = await createInlineMission('registry mcp rerun A', repoPath);
    const second = await createInlineMission('registry mcp rerun B', repoPath);

    const packetId = first.packets[0]?.id;
    expect(packetId).toBeTruthy();
    const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    const durablePacket = readMissionRegistryEntry(first.missionId, { includeArchived: true })
      ?.mission.packets.find((candidate) => candidate.id === packetId);
    const { createLane, findLaneByPacket, getLane } = await import('@/lib/lane/registry');
    const retiredLane = createLane({
      repoPath,
      branch: durablePacket!.branchTarget,
      runtime: 'codex',
      packetId: packetId!,
    });
    expect(retiredLane?.id).toMatch(/^lane-/);
    const { listApprovalsForContext, recordOrchestratorReview } = await import('@/lib/approvals/store');
    recordOrchestratorReview(packetId!, {
      approved: true,
      findings: [],
      reviewedHeadSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim(),
    });
    const { handleRerunWithFeedback } = await import('@/lib/mcp/operator-handlers/mission');
    const result = parseJsonResult<{ dispatched?: boolean; referenceLabel?: string }>(await handleRerunWithFeedback({
      packetId: packetId!,
      feedback: 'tighten the implementation',
    }));

    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    expect(result.dispatched).toBe(true);
    expect(result.referenceLabel).toBe('inline-1');
    expect(findLaneByPacket(packetId!)?.id).toMatch(/^lane-/);
    expect(findLaneByPacket(packetId!)?.id).not.toBe(retiredLane!.id);
    expect(getLane(retiredLane!.id)?.packetId).toBeFalsy();
    const rerunPacket = (await import('@/lib/orchestrator/mission-registry'))
      .readMissionRegistryEntry(first.missionId, { includeArchived: true })?.mission.packets
      .find((candidate) => candidate.id === packetId);
    expect(rerunPacket?.storageAdmissionEpoch).toBe(2);
    expect(readOrchestratorControlPlaneState().missionId).toBe(second.missionId);
    expect(listApprovalsForContext({ packetId }).find((approval) => (
      approval.toolName === 'orchestrator_review'
    ))?.args).toMatchObject({
      reviewSuperseded: true,
      reviewSupersededReason: 'Superseded by rerun_with_feedback.',
    });
  }, 20_000);

  it('rerun_with_feedback clears released truth before relaunching a registry packet', async () => {
    const repoPath = createTempRepo();
    stubMissionApiFetch();
    const first = await createInlineMission('registry released rerun A', repoPath);
    const second = await createInlineMission('registry released rerun B', repoPath);

    const packetId = first.packets[0]?.id;
    expect(packetId).toBeTruthy();
    const { withMissionRegistryState, readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    await withMissionRegistryState(first.missionId, (current) => {
      const packet = current.packets.find((candidate) => candidate.id === packetId);
      expect(packet).toBeTruthy();
      packet!.status = 'released';
      packet!.queueState = 'held';
      packet!.releaseState = 'released';
      packet!.releaseStatePayload = {
        mergeCommit: 'abc123',
        releasedAt: '2026-07-06T12:00:00.000Z',
        source: 'test',
      };
      packet!.lastEventLabel = 'headless_released';
      return { state: current, result: null };
    });

    const { handleRerunWithFeedback } = await import('@/lib/mcp/operator-handlers/mission');
    const result = parseJsonResult<{ dispatched?: boolean; referenceLabel?: string }>(await handleRerunWithFeedback({
      packetId: packetId!,
      feedback: 'rerun the released packet',
    }));

    const packet = readMissionRegistryEntry(first.missionId, { includeArchived: true })?.mission.packets
      .find((candidate) => candidate.id === packetId);
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');

    expect(result.dispatched).toBe(true);
    expect(packet?.releaseState).toBe('pending');
    expect(packet?.releaseStatePayload).toBeNull();
    expect(packet?.status).toBe('launching');
    expect(packet?.queueState).toBe('queued');
    expect(packet?.lastEventLabel).not.toBe('headless_released');
    expect(readOrchestratorControlPlaneState().missionId).toBe(second.missionId);
  }, 20_000);

  it('returns a clean unknown-packet error through the retry MCP handler', async () => {
    stubMissionApiFetch();
    const { handleRetryPacket } = await import('@/lib/mcp/operator-handlers/mission');
    const result = parseJsonResult<{ error?: string }>(await handleRetryPacket({
      packetId: 'pkt-missing-from-registry',
      reason: 'negative case',
    }));
    expect(result.error).toContain('Packet pkt-missing-from-registry not found');
  });

  it('serializes registry-row mutations per mission', async () => {
    const repoPath = createTempRepo();
    stubMissionApiFetch();
    const mission = await createInlineMission('registry mutation serialization', repoPath);
    const { readMissionRegistryEntry, withMissionRegistryState } = await import('@/lib/orchestrator/mission-registry');
    const observed: string[] = [];

    await Promise.all([
      withMissionRegistryState(mission.missionId, async (state) => {
        observed.push(`first:${state.constraints}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { state: { ...state, constraints: 'first-write' }, result: null };
      }),
      withMissionRegistryState(mission.missionId, (state) => {
        observed.push(`second:${state.constraints}`);
        return { state: { ...state, summary: `second saw ${state.constraints}` }, result: null };
      }),
    ]);

    const persisted = readMissionRegistryEntry(mission.missionId, { includeArchived: true })?.mission;
    expect(observed).toEqual(['first:', 'second:first-write']);
    expect(persisted?.summary).toBe('second saw first-write');
  });

  it('keeps registry versions monotonic when multiple mutations share one clock tick', async () => {
    const repoPath = createTempRepo();
    stubMissionApiFetch();
    const mission = await createInlineMission('registry monotonic version', repoPath);
    const {
      persistMissionRegistryStateIfVersion,
      readMissionRegistryEntry,
      withMissionRegistryState,
    } = await import('@/lib/orchestrator/mission-registry');
    const before = readMissionRegistryEntry(mission.missionId, { includeArchived: true })!;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(before.updatedAt);
    try {
      await withMissionRegistryState(mission.missionId, (state) => ({
        state: { ...state, constraints: 'newer-registry-truth' },
        result: null,
      }));
      const after = readMissionRegistryEntry(mission.missionId, { includeArchived: true })!;
      expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
      await expect(persistMissionRegistryStateIfVersion(
        { ...before.mission, summary: 'stale outgoing snapshot' },
        before.updatedAt,
      )).resolves.toBe(false);
      expect(readMissionRegistryEntry(mission.missionId, { includeArchived: true })?.mission)
        .toMatchObject({ constraints: 'newer-registry-truth' });
    } finally {
      clock.mockRestore();
    }
  });
});
