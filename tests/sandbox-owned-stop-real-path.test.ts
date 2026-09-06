import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

// Keep retirement outside this test. Auth, route, lifecycle hold, saved-session
// lookup, process identity, signals, and persisted kill events are all real.
vi.mock('@/lib/orchestrator/operator-mission-service', () => ({
  resetPacket: vi.fn(async () => ({ reset: true, worktreePruned: false })),
}));

const root = mkdtempSync(join(tmpdir(), 'o8-sandbox-stop-'));
const dataDir = join(root, 'data');
const repoPath = join(root, 'repo');
const token = 'sandbox-stop-fixture-operator-token-0123456789';
mkdirSync(dataDir);
mkdirSync(repoPath);
writeFileSync(join(dataDir, 'ws-token'), token);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = join(dataDir, 'owned-claude-code');

const { POST } = await import('@/app/api/orchestrator/stop-packet/route');
const { createLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } =
  await import('@/lib/orchestrator/control-plane');
const { closeDb } = await import('@/lib/db');
const { isPidAlive, pidCommandLine } = await import('@/lib/runtimes/shared/owned-session/helpers');
const { prepareWorkerSandbox } = await import('@/lib/runtimes/shared/owned-session/sandbox');
const { resolveSpawnedProcessGroupId } = await import('@/lib/runtimes/shared/owned-session/run-process-proof');

const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid && isPidAlive(child.pid)) {
      const done = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await done;
    }
    expect(child.pid && isPidAlive(child.pid)).toBe(false);
  }
});
afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

async function spawnWorker(marker: string) {
  const prepared = await prepareWorkerSandbox({
    runId: randomUUID(), profileDir: root, cwd: repoPath, repoPath,
    binary: process.execPath,
    args: ['-e', 'setTimeout(() => process.exit(0), 20000); process.stdout.write("ready\\n");'],
    tmpDir: root,
  });
  const child = spawn(prepared.binary, prepared.args, {
    cwd: repoPath, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    // Fixture-only environment; no provider or operator credentials.
    env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin', O8_OWNED_RUN_MARKER: marker },
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Sandbox child did not become ready')), 5000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    child.once('error', finish);
    child.once('exit', () => finish(new Error('Sandbox child exited before readiness')));
    child.stdout!.once('data', () => finish());
  });
  expect(await pidCommandLine(child.pid!)).not.toContain('sandbox-exec');
  expect(await resolveSpawnedProcessGroupId(child.pid!)).toBe(child.pid);
  return child;
}

function bindWorker(pid: number, marker: string | undefined, processGroupId = pid, commandIdentity = 'sandbox-exec') {
  const id = randomUUID();
  const surfaceId = 'claude-code-owned:' + id;
  const packetId = 'pkt-' + id;
  const lane = createLane({
    repoPath, branch: 'inline/stop-' + id, runtime: 'claude-code',
    packetId, sessionKey: surfaceId,
  });
  setLaneStatus(lane.id, 'running', 'system', 'test_running');
  const sessionDir = join(dataDir, 'owned-claude-code', id);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
    surfaceId, repoPath, cwd: repoPath, laneId: lane.id, packetId,
    activeRun: {
      id: marker, pid, processGroupId, processMarker: marker,
      commandIdentity, spawnState: 'spawned', sandboxed: commandIdentity === 'sandbox-exec',
      outcome: 'running', startedAt: new Date().toISOString(),
    },
  }));
  const packet: OrchestratorPacket = {
    id: packetId, referenceLabel: 'stop', title: 'sandbox stop', summary: 'stop identity',
    workspaceTargetPath: repoPath, branchTarget: lane.branch, runtime: 'claude-code',
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued',
    releaseState: 'pending', status: 'running', blockedReason: null,
    lastEventAt: null, lastEventLabel: null, archivedAt: null, review: null,
    orchestratorThreadId: null, operatorStopped: false,
    lane: {
      tileId: lane.id, tabId: lane.id, repoPath, worktreePath: null,
      runtime: 'claude-code', sessionKey: surfaceId, laneId: lane.id,
      lastHeartbeatAt: null, lastEventAt: null, lastEventLabel: null,
    },
  };
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    missionId: 'mission-' + id, repoPath, packets: [packet],
  });
  return { packetId, laneId: lane.id };
}

function stop(packetId: string) {
  return POST(new NextRequest('http://localhost/api/orchestrator/stop-packet', {
    method: 'POST',
    headers: { host: 'localhost', authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ packetId }),
  }));
}

describe.skipIf(process.platform !== 'darwin')('sandboxed owned stop through the production route', () => {
  it('stops after wrapper exec and persists confirmed kill and operator hold', async () => {
    const marker = randomUUID();
    const child = await spawnWorker(marker);
    const target = bindWorker(child.pid!, marker);
    const response = await stop(target.packetId);
    expect(response.status).toBe(200);
    expect(isPidAlive(child.pid!)).toBe(false);
    closeDb();
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      operatorStopped: true, queueState: 'held', blockedReason: 'operator_stopped',
    });
    expect(getLaneEvents(target.laneId, 50).filter((event) => event.verb === 'kill_escalated'))
      .toEqual([expect.objectContaining({ payload: expect.objectContaining({
        pid: child.pid, stage: 'SIGINT', confirmed: true,
      }) })]);
  });

  it.each(['different', 'prefix', 'missing', 'group', 'legacy'] as const)(
    'refuses %s identity evidence without signaling a live process',
    async (kind) => {
      const marker = randomUUID();
      const child = await spawnWorker(kind === 'prefix' ? marker + '-other' : marker);
      const target = bindWorker(
        child.pid!, kind === 'missing' || kind === 'legacy' ? undefined : kind === 'different' ? randomUUID() : marker,
        kind === 'group' ? process.pid : child.pid!,
        kind === 'legacy' ? process.execPath : 'sandbox-exec',
      );
      const response = await stop(target.packetId);
      expect(response.status).toBe(409);
      expect(isPidAlive(child.pid!)).toBe(true);
      closeDb();
      expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
        operatorStopped: true, queueState: 'held', blockedReason: 'kill_unconfirmed',
      });
      expect(getLaneEvents(target.laneId, 50).filter((event) => event.verb === 'kill_escalated')).toEqual([]);
    },
  );
});
