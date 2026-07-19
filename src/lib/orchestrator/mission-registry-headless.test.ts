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

  it('retry_packet mutates a non-current registry packet through the real MCP handler', async () => {
    const repoPath = createTempRepo();
    stubMissionApiFetch();
    const first = await createInlineMission('registry mcp retry A', repoPath);
    const second = await createInlineMission('registry mcp retry B', repoPath);

    const packetId = first.packets[0]?.id;
    expect(packetId).toBeTruthy();
    const { handleRetryPacket } = await import('@/lib/mcp/operator-handlers/mission');
    const retryResult = parseJsonResult<{ reset?: boolean; referenceLabel?: string }>(await handleRetryPacket({
      packetId: packetId!,
      reason: 'retry non-current packet',
    }));

    const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const packet = readMissionRegistryEntry(first.missionId, { includeArchived: true })?.mission.packets
      .find((candidate) => candidate.id === packetId);

    expect(retryResult.reset).toBe(true);
    expect(retryResult.referenceLabel).toBe('inline-1');
    expect(packet?.status).toBe('draft');
    expect(packet?.queueState).toBe('held');
    expect(readOrchestratorControlPlaneState().missionId).toBe(second.missionId);
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

  it('rerun_with_feedback relaunches a non-current registry packet through the real MCP handler', async () => {
    const repoPath = createTempRepo();
    stubMissionApiFetch();
    const first = await createInlineMission('registry mcp rerun A', repoPath);
    const second = await createInlineMission('registry mcp rerun B', repoPath);

    const packetId = first.packets[0]?.id;
    expect(packetId).toBeTruthy();
    const { handleRerunWithFeedback } = await import('@/lib/mcp/operator-handlers/mission');
    const result = parseJsonResult<{ dispatched?: boolean; referenceLabel?: string }>(await handleRerunWithFeedback({
      packetId: packetId!,
      feedback: 'tighten the implementation',
    }));

    const { findLaneByPacket } = await import('@/lib/lane/registry');
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    expect(result.dispatched).toBe(true);
    expect(result.referenceLabel).toBe('inline-1');
    expect(findLaneByPacket(packetId!)?.id).toMatch(/^lane-/);
    expect(readOrchestratorControlPlaneState().missionId).toBe(second.missionId);
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
});
