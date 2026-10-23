import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const root = mkdtempSync(join(tmpdir(), 'o8-dispatch-queue-'));
const repoPath = join(root, 'repo');
vi.stubEnv('O8_MAX_PARALLEL_DISPATCHES', '2');
vi.stubEnv('O8_STRICT_OVERLAP_GATE', '0');
const { closeDb } = await import('@/lib/db');
const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { writeOrchestratorControlPlaneState, withLockedState } = await import('@/lib/orchestrator/control-plane');
const { recordMission } = await import('@/lib/db/missions-store');
const { readMissionRegistryEntry, withMissionRegistryState } = await import('@/lib/orchestrator/mission-registry');
const dispatchRoute = await import('@/app/api/orchestrator/dispatch/route');
const statusRoute = await import('@/app/api/orchestrator/status/route');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const token = getOrCreateWsToken();
const lanes: string[] = [];
let sequence = 0;

beforeAll(() => {
  mkdirSync(repoPath);
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
  writeFileSync(join(repoPath, 'README.md'), 'queue fixture\n');
  execFileSync('git', ['-C', repoPath, 'add', 'README.md']);
  execFileSync('git', ['-C', repoPath, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
});
afterEach(() => {
  for (const laneId of lanes.splice(0)) setLaneStatus(laneId, 'archived', 'system', 'fixture_cleanup');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => {
  closeDb();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function packet(id: string): OrchestratorPacket {
  return { id, referenceLabel: id, title: id, summary: id, runtime: 'codex',
    workspaceTargetPath: repoPath, branchTarget: `fixture/${id}`, dependencyLabels: [],
    dependencyPacketIds: [], queueState: 'queued', releaseState: 'pending', status: 'queued',
    blockedReason: null, lane: null };
}
async function seed(registry = false) {
  const missionId = `queue-${++sequence}`;
  for (let i = 0; i < 2; i++) {
    const lane = createLane({ repoPath, branch: `fixture/active-${sequence}-${i}`, baseBranch: 'main',
      runtime: 'codex', packetId: `other-mission-${sequence}-${i}` });
    setLaneStatus(lane.id, 'running', 'system', 'fixture_running');
    lanes.push(lane.id);
  }
  const state = { ...createEmptyOrchestratorMissionState(), missionId, repoPath, runtime: 'codex' as const,
    packets: [packet(`${missionId}-a`), packet(`${missionId}-b`)] };
  if (registry) {
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: `current-${sequence}`, repoPath });
    recordMission({ id: missionId, repoPath, runtime: 'codex', prompt: '', summary: '', constraints: '',
      packetMeta: state.packets, missionState: state, totalWaves: 1 });
  } else writeOrchestratorControlPlaneState(state);
  closeDb();
  return state;
}
function request(path: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function postDispatch(req: NextRequest) {
  const { missionId } = await req.clone().json() as { missionId: string };
  const response = await dispatchRoute.POST(req);
  // Drain background dispatch before another fixture can replace its active mission
  // or free its capacity. The receipt itself still comes from the async route.
  await withLockedState(async () => undefined);
  if (readMissionRegistryEntry(missionId, { includeArchived: true })) {
    for (let i = 0; i < 2; i++) {
      await withMissionRegistryState(missionId, (state) => ({ state, result: undefined }));
    }
  }
  return response;
}
async function dispatch(missionId: string, wait: boolean) {
  const response = await postDispatch(request('/api/orchestrator/dispatch', { missionId, wait }));
  expect(response.status).toBe(200);
  return (await response.json()).result;
}
async function status(missionId: string) {
  closeDb();
  const response = await statusRoute.GET(request(`/api/orchestrator/status?missionId=${missionId}`));
  expect(response.status).toBe(200);
  return (await response.json()).result;
}

describe('dispatch queue receipts through persisted routes and CLI', () => {
  it.each([false, true])('reports capacity and mission positions for current and registry dispatch (wait=%s)', async (wait) => {
    for (const registry of [false, true]) {
      const state = await seed(registry);
      const receipt = await dispatch(state.missionId, wait);
      expect(receipt).toMatchObject({ status: 'queued', queued: [
        { packetId: state.packets[0].id, reason: 'concurrency-limit', limit: 2, running: 2, position: 1 },
        { packetId: state.packets[1].id, reason: 'concurrency-limit', limit: 2, running: 2, position: 2 },
      ] });
      if (wait) expect(receipt).toMatchObject({ dispatched: 0, activeAgents: [] });
      const snapshot = await status(state.missionId);
      for (const [i, entry] of snapshot.packets.entries()) {
        expect(entry.dispatchQueue).toEqual(receipt.queued[i]);
        expect(entry.blockedReason).toBe(receipt.queued[i].detail);
      }
      // Live projection must clear obsolete capacity reasons once slots free.
      for (const laneId of lanes.splice(0)) setLaneStatus(laneId, 'archived', 'system', 'fixture_complete');
      expect((await status(state.missionId)).packets[0].dispatchQueue.reason).toBe('scheduler-deferred');
    }
  });

  it('returns the network cooldown and retry time on dispatch and reopened status', async () => {
    const state = await seed();
    const { recoverWorktreeFetchUnreachable, recordFetchUnreachableRecoverySuccess } = await import('@/lib/runtime/fetch-unreachable-recovery');
    const { WorktreeFetchUnreachableError } = await import('@/lib/worktree/manager');
    const error = new WorktreeFetchUnreachableError({ worktreePath: repoPath, baseBranch: 'main', branch: 'fixture/network',
      localRefAgeMs: 1_000, fetchErrorMessage: 'fixture offline' });
    recoverWorktreeFetchUnreachable({ error, repoPath, packetId: state.packets[0].id,
      laneId: null, runtime: 'codex', stage: 'pre_lane_receipt' });
    try {
      const receipt = await dispatch(state.missionId, true);
      expect(receipt.queued[0]).toMatchObject({ reason: 'fetch-unreachable', retryInSeconds: expect.any(Number) });
      expect(receipt.queued[0].retryInSeconds).toBeGreaterThan(0);
      expect((await status(state.missionId)).packets[0].dispatchQueue.reason).toBe('fetch-unreachable');
    } finally { recordFetchUnreachableRecoverySuccess(repoPath); }
  });

  it('keeps held and dependency-blocked packets out of the capacity queue', async () => {
    const state = await seed();
    state.packets[0].queueState = 'held';
    state.packets[1].dependencyPacketIds = [state.packets[0].id];
    writeOrchestratorControlPlaneState(state);
    const receipt = await dispatch(state.missionId, true);
    expect(receipt).toMatchObject({ status: 'not-dispatched', dispatched: 0, queued: [], skipped: [
      { packetId: state.packets[0].id, reason: 'held' },
      { packetId: state.packets[1].id, reason: 'blocked-by' },
    ] });
    expect((await status(state.missionId)).packets.every((entry: { dispatchQueue: unknown }) => entry.dispatchQueue === null)).toBe(true);
  });

  it('MCP dispatch returns the final queue receipt without retrying it', async () => {
    const state = await seed();
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(url)).pathname === '/api/orchestrator/dispatch') {
        return postDispatch(request('/api/orchestrator/dispatch', JSON.parse(String(init?.body))));
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { handleDispatchMission } = await import('@/lib/mcp/operator-handlers/mission');
    const result = await handleDispatchMission({ missionId: state.missionId });
    const content = result.content.find((entry) => entry.type === 'text');
    expect(content?.type).toBe('text');
    if (content?.type !== 'text') throw new Error('Expected a text tool result.');
    expect(JSON.parse(content.text)).toMatchObject({ status: 'queued', dispatched: 0, queued: [
      { reason: 'concurrency-limit', position: 1 }, { reason: 'concurrency-limit', position: 2 },
    ] });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/orchestrator/dispatch'))).toHaveLength(1);
  });

  it.each([false, true])('CLI surfaces queued receipts once without replaying a final queue result (wait=%s)', async (wait) => {
    const state = await seed();
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/orchestrator/dispatch') return postDispatch(request(path, JSON.parse(String(init?.body))));
      if (path === '/api/orchestrator/status') return statusRoute.GET(request(`/api/orchestrator/status?missionId=${state.missionId}`));
      throw new Error(`Unexpected fixture request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { runMission } = await import('../cli/src/commands/mission');
    await expect(runMission({ human: true, verbose: false }, 'dispatch', ['--mission', state.missionId, ...(wait ? ['--wait'] : [])])).resolves.toBe(0);
    expect(output.mock.calls.map(([value]) => String(value)).join('')).toContain('queued');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/dispatch'))).toHaveLength(1);
    output.mockClear();
    await runMission({ human: true, verbose: false }, 'status', ['--mission', state.missionId]);
    expect(output.mock.calls.map(([value]) => String(value)).join('')).toContain('concurrency limit');
  });
});
