import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
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

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/auth/principal', () => ({ resolveRequestPrincipal: () => 'operator' }));

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const,
    probePath: '/',
    availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000,
    error: null,
  })),
}));

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
      const { POST } = await import('@/app/api/orchestrator/dispatch/route');
      return POST(new NextRequest(urlText, { method: init?.method ?? 'POST', headers: init?.headers, body: JSON.stringify(body) }));
    }
    if (urlText.includes('/api/orchestrator/reset-packet')) {
      const { POST } = await import('@/app/api/orchestrator/reset-packet/route');
      return POST(new NextRequest(urlText, { method: init?.method ?? 'POST', headers: init?.headers, body: JSON.stringify(body) }));
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

describe('retry salvage durable publication through routes', () => {
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
    const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    const { getSqlite } = await import('@/lib/db');
    const reopened = new Database(getSqlite().name, { readonly: true });
    let persisted;
    try {
      persisted = reopened.prepare('SELECT mission_state_json FROM missions WHERE id = ?').get(mission.missionId) as { mission_state_json: string };
    } finally {
      reopened.close();
    }
    expect(JSON.parse(persisted.mission_state_json).packets.find((candidate: { id: string }) => candidate.id === packetId)).toMatchObject({
      status: 'awaiting_review', lane: { laneId: retry.laneId, worktreePath: repoPath, sessionKey: null },
    });
    expect(readMissionRegistryEntry(mission.missionId, { includeArchived: true })?.mission.packets.find(candidate => candidate.id === packetId)).toMatchObject({
      status: 'awaiting_review', lane: { laneId: retry.laneId, worktreePath: repoPath, sessionKey: null },
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
  }, 60_000);


  async function readyCommittedPacket() {
    const repoPath = createTempRepo();
    stubMissionApiFetch();
    const mission = await createInlineMission('current retry publication', repoPath);
    const packetId = mission.packets[0]!.id;
    const { handleDispatchMission } = await import('@/lib/mcp/operator-handlers/mission');
    expect(parseJsonResult<{ dispatched?: number }>(await handleDispatchMission({ missionId: mission.missionId })).dispatched).toBe(1);
    const { findLaneByPacket, setLaneStatus } = await import('@/lib/lane/registry');
    const oldLane = findLaneByPacket(packetId)!;
    commitWorkerResult(repoPath, oldLane.branch);
    setLaneStatus(oldLane.id, 'failed', 'system', 'zero_diff_failed');
    retrySalvageKillSeam.forceConfirmed = true;
    return { repoPath, mission, packetId, oldLane };
  }

  async function retryRoute(packetId: string, idempotencyKey: string) {
    const { POST } = await import('@/app/api/orchestrator/reset-packet/route');
    return POST(new NextRequest('http://localhost/api/orchestrator/reset-packet', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ packetId, idempotencyKey }),
    }));
  }

  it('preserves concurrent mission metadata when publishing only the reviewed packet', async () => {
    const { mission, packetId } = await readyCommittedPacket();
    const { withMissionRegistryState, readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    retrySalvageKillSeam.afterConfirmed = async () => {
      await withMissionRegistryState(mission.missionId, state => {
        state.packets.find(candidate => candidate.id === packetId)!.completionSummary = 'concurrent packet metadata';
        return { state: { ...state, constraints: 'concurrent durable metadata' }, result: null };
      });
    };
    const response = await retryRoute(packetId, 'metadata-publication');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.salvaged).toBe(true);
    expect(readMissionRegistryEntry(mission.missionId)?.mission).toMatchObject({
      constraints: 'concurrent durable metadata',
      packets: [expect.objectContaining({ status: 'awaiting_review', completionSummary: 'concurrent packet metadata', lane: expect.objectContaining({ laneId: body.result.laneId }) })],
    });
  }, 60_000);

  it.each(['generation', 'lane', 'current generation'] as const)('refuses a concurrent durable %s owner before retiring the old lane', async (change) => {
    const { mission, packetId, oldLane } = await readyCommittedPacket();
    const { withMissionRegistryState, readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    const { getLane, listLanes } = await import('@/lib/lane/registry');
    retrySalvageKillSeam.afterConfirmed = async () => {
      if (change === 'current generation') {
        const { withLockedState } = await import('@/lib/orchestrator/control-plane');
        await withLockedState(state => {
          const packet = state.packets.find(candidate => candidate.id === packetId)!;
          packet.storageAdmissionEpoch = (packet.storageAdmissionEpoch ?? 0) + 1;
        });
        return;
      }
      await withMissionRegistryState(mission.missionId, state => {
        const packet = state.packets.find(candidate => candidate.id === packetId)!;
        if (change === 'generation') packet.storageAdmissionEpoch = (packet.storageAdmissionEpoch ?? 0) + 1;
        else packet.lane = { ...packet.lane!, laneId: 'lane-concurrent-owner' };
        return { state, result: null };
      });
    };
    const response = await retryRoute(packetId, `owner-${change}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'reset_state_changed' } });
    expect(getLane(oldLane.id)).toMatchObject({ packetId, worktreePath: oldLane.worktreePath });
    expect(listLanes().filter(lane => lane.packetId === packetId)).toHaveLength(1);
    const stored = readMissionRegistryEntry(mission.missionId)!.mission.packets.find(packet => packet.id === packetId)!;
    if (change === 'generation') expect(stored.storageAdmissionEpoch).toBe(2);
    else if (change === 'lane') expect(stored.lane?.laneId).toBe('lane-concurrent-owner');
    else {
      const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
      expect(readOrchestratorControlPlaneState().packets.find(packet => packet.id === packetId)?.storageAdmissionEpoch).toBe(2);
    }
    expect(launchMock.calls).toHaveLength(1);
  }, 60_000);

  it.each(['conflict', 'unavailable'] as const)('persists and replays %s publication failure without repeating the partial bind', async (failure) => {
    const { mission, packetId, oldLane, repoPath } = await readyCommittedPacket();
    const registry = await import('@/lib/orchestrator/mission-registry');
    const publication = vi.spyOn(registry, 'persistMissionRegistryStateIfVersion');
    if (failure === 'conflict') publication.mockResolvedValueOnce(false);
    else publication.mockRejectedValueOnce(new Error('fixture registry unavailable'));
    const response = await retryRoute(packetId, `publication-failure-${failure}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'retry_salvage_publication_failed' } });
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const packet = readOrchestratorControlPlaneState().packets.find(candidate => candidate.id === packetId)!;
    expect(packet).toMatchObject({ queueState: 'held', operatorStopped: true, blockedReason: 'retry_salvage_publication_failed', lane: { worktreePath: repoPath } });
    expect(packet.lane?.laneId).not.toBe(oldLane.id);
    expect(registry.readMissionRegistryEntry(mission.missionId)!.mission.packets.find(candidate => candidate.id === packetId)?.lane?.laneId).toBe(oldLane.id);
    const { getSqlite } = await import('@/lib/db');
    const rows = getSqlite().prepare('SELECT result_json FROM idempotency_keys WHERE verb = ? AND packet_id = ?').all('reset_packet', packetId) as Array<{ result_json: string }>;
    expect(rows.map(row => JSON.parse(row.result_json))).toContainEqual(expect.objectContaining({ ok: false, code: 'retry_salvage_publication_failed', status: 503 }));
    const replay = await retryRoute(packetId, `publication-failure-${failure}`);
    expect(replay.status).toBe(503);
    expect(replay.headers.get('x-o8-idempotency-replayed')).toBe('1');
    const { listLanes } = await import('@/lib/lane/registry');
    expect(listLanes().filter(lane => lane.packetId === packetId)).toHaveLength(1);
    const { POST } = await import('@/app/api/orchestrator/dispatch/route');
    const dispatch = await POST(new NextRequest('http://localhost/api/orchestrator/dispatch', { method: 'POST', body: JSON.stringify({ missionId: mission.missionId }) }));
    expect(dispatch.status).toBe(409);
    expect(launchMock.calls).toHaveLength(1);
  }, 60_000);
});
