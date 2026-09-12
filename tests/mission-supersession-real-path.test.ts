import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const launchMock = vi.hoisted(() => ({
  calls: [] as Array<{ packetId?: string; repoPath: string }>,
}));

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

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-mission-supersession-'));
const tempRepos: string[] = [];
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

function createTempRepo() {
  const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-mission-supersession-repo-'));
  tempRepos.push(repoPath);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  writeFileSync(join(repoPath, 'README.md'), 'mission supersession test\n');
  git('add', 'README.md');
  git('-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '-m', 'init');
  return repoPath;
}

async function createMissionThroughRoute(input: {
  clientMutationId: string;
  issueNumber: number;
  repoPath: string;
  threadId: string;
  title: string;
}) {
  const { NextRequest } = await import('next/server');
  const { POST } = await import('@/app/api/orchestrator/create-mission/route');
  const response = await POST(new NextRequest('http://127.0.0.1:47120/api/orchestrator/create-mission', {
    method: 'POST',
    headers: { host: 'localhost:47120', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientMutationId: input.clientMutationId,
      repoPath: input.repoPath,
      runtime: 'codex',
      orchestratorThreadId: input.threadId,
      issues: [{
        number: input.issueNumber,
        title: input.title,
        body: `${input.title} body`,
        url: '',
      }],
    }),
  }));
  const payload = await response.json() as {
    ok: boolean;
    result: { missionId: string; packets: Array<{ id: string }> };
  };
  expect(response.status).toBe(201);
  expect(payload.ok).toBe(true);
  return payload.result;
}

afterEach(async () => {
  const { archiveLane, listLanes } = await import('@/lib/lane/registry');
  for (const lane of listLanes()) {
    if (lane.status !== 'archived') archiveLane(lane.id, 'system');
  }
  launchMock.calls = [];
  for (const repoPath of tempRepos.splice(0)) {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

afterAll(async () => {
  const { closeDb } = await import('@/lib/db');
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('mission supersession real path', () => {
  it('cancels the predecessor before the headless dispatcher can create its lane', async () => {
    const repoPath = createTempRepo();
    const threadId = 'thread-supersede-2196';
    const first = await createMissionThroughRoute({
      clientMutationId: 'supersede-first-2196',
      issueNumber: 219_601,
      repoPath,
      threadId,
      title: 'superseded thread mission',
    });
    const second = await createMissionThroughRoute({
      clientMutationId: 'supersede-second-2196',
      issueNumber: 219_602,
      repoPath,
      threadId,
      title: 'surviving thread mission',
    });
    const firstPacketId = first.packets[0]!.id;
    const secondPacketId = second.packets[0]!.id;

    const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    expect(readMissionRegistryEntry(first.missionId, { includeArchived: true })?.mission.packets[0])
      .toMatchObject({
        status: 'blocked',
        queueState: 'held',
        operatorStopped: true,
        blockedReason: 'superseded_by_newer_mission',
        lastEventLabel: 'superseded_by_newer_mission',
        releaseStatePayload: { source: `mission_superseded:${second.missionId}` },
      });

    const { runHeadlessSprintTick } = await import('@/lib/orchestrator/headless-loop');
    const { findLaneByPacket } = await import('@/lib/lane/registry');
    await runHeadlessSprintTick();

    expect(findLaneByPacket(firstPacketId)).toBeNull();
    expect(findLaneByPacket(secondPacketId)?.id).toMatch(/^lane-/);
    expect(launchMock.calls.map((call) => call.packetId)).toEqual([secondPacketId]);
  }, 20_000);

  it('keeps an in-flight predecessor on its normal review path', async () => {
    const repoPath = createTempRepo();
    const threadId = 'thread-in-flight-supersede-2196';
    const first = await createMissionThroughRoute({
      clientMutationId: 'in-flight-first-2196',
      issueNumber: 219_603,
      repoPath,
      threadId,
      title: 'in-flight thread mission',
    });

    const { dispatchMission } = await import('@/lib/orchestrator/operator-mission-service/mission');
    await expect(dispatchMission({ missionId: first.missionId })).resolves.toMatchObject({ dispatched: 1 });
    await createMissionThroughRoute({
      clientMutationId: 'in-flight-second-2196',
      issueNumber: 219_604,
      repoPath,
      threadId,
      title: 'newer thread mission',
    });

    const firstPacketId = first.packets[0]!.id;
    const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    const { findLaneByPacket } = await import('@/lib/lane/registry');
    const inFlightPacket = readMissionRegistryEntry(first.missionId, { includeArchived: true })
      ?.mission.packets.find((packet) => packet.id === firstPacketId);
    expect(inFlightPacket).toMatchObject({ status: 'running' });
    expect(inFlightPacket?.operatorStopped).not.toBe(true);
    expect(inFlightPacket?.blockedReason).not.toBe('superseded_by_newer_mission');
    expect(findLaneByPacket(firstPacketId)?.id).toMatch(/^lane-/);
  }, 20_000);
});
