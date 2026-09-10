import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = join(dataDir, 'owned-codex');

const { POST } = await import('@/app/api/orchestrator/stop-packet/route');
const laneRoute = await import('@/app/api/lanes/route');
const { recordLaneEvent } = await import('@/lib/lane/events');
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

function bindWorker(
  pid: number, marker: string | undefined, processGroupId = pid,
  commandIdentity = 'sandbox-exec', runtime: 'claude-code' | 'codex' = 'claude-code',
) {
  const id = randomUUID();
  const surfaceId = runtime + '-owned:' + id;
  const packetId = 'pkt-' + id;
  const lane = createLane({
    repoPath, branch: 'inline/stop-' + id, runtime,
    packetId, sessionKey: surfaceId,
  });
  setLaneStatus(lane.id, 'running', 'system', 'test_running');
  const sessionDir = join(dataDir, 'owned-' + runtime, id);
  mkdirSync(sessionDir, { recursive: true });
  const run = {
    id: marker, pid, processGroupId, processMarker: marker,
    commandIdentity, spawnState: 'spawned', sandboxed: commandIdentity === 'sandbox-exec',
    outcome: 'running', startedAt: new Date().toISOString(),
    stdoutPath: join(sessionDir, 'run.jsonl'), stderrPath: join(sessionDir, 'run.stderr.log'),
  };
  writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
    surfaceId, sessionDir, repoPath, cwd: repoPath, laneId: lane.id, packetId,
    activeRun: run, recentRuns: [run],
  }));
  const packet: OrchestratorPacket = {
    id: packetId, referenceLabel: 'stop', title: 'sandbox stop', summary: 'stop identity',
    workspaceTargetPath: repoPath, branchTarget: lane.branch, runtime,
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued',
    releaseState: 'pending', status: 'running', blockedReason: null,
    lastEventAt: null, lastEventLabel: null, archivedAt: null, review: null,
    orchestratorThreadId: null, operatorStopped: false,
    lane: {
      tileId: lane.id, tabId: lane.id, repoPath, worktreePath: null,
      runtime, sessionKey: surfaceId, laneId: lane.id,
      lastHeartbeatAt: null, lastEventAt: null, lastEventLabel: null,
    },
  };
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    missionId: 'mission-' + id, repoPath, packets: [packet],
  });
  return { packetId, laneId: lane.id, sessionDir };
}

function stop(packetId: string) {
  return POST(new NextRequest('http://localhost/api/orchestrator/stop-packet', {
    method: 'POST',
    headers: { host: 'localhost', authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ packetId }),
  }));
}

describe.skipIf(process.platform !== 'darwin')('sandboxed owned stop through the production route', () => {
  describe.each([
    ['packet', 'claude-code'], ['lane', 'claude-code'],
    ['packet', 'codex'], ['lane', 'codex'],
  ] as const)('%s Stop after a completed %s turn', (entry, runtime) => {
    async function stopTarget(target: ReturnType<typeof bindWorker>) {
      if (entry === 'packet') return stop(target.packetId);
      return laneRoute.POST(new NextRequest('http://localhost/api/lanes', {
        method: 'POST',
        headers: { host: 'localhost', authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ verb: 'stop', laneId: target.laneId }),
      }));
    }

    function recordPreviousExit(target: ReturnType<typeof bindWorker>) {
      const saved = JSON.parse(readFileSync(join(target.sessionDir, 'session.json'), 'utf8'));
      recordLaneEvent(target.laneId, 'runtime_process_exit', 'system', {
        surfaceId: saved.surfaceId, runId: 'previous-completed-run',
        classification: 'clean-exit', exitCode: 0, runtimeOutcome: 'finished',
      });
    }

    it('kills the current resumed run despite an earlier same-session exit', async () => {
      const marker = randomUUID();
      const child = await spawnWorker(marker);
      const target = bindWorker(child.pid!, marker, child.pid!, 'sandbox-exec', runtime);
      recordPreviousExit(target);
      // No admission event is required: saved process truth also covers the
      // interval before resume admission is recorded and delayed exit events.
      const response = await stopTarget(target);
      expect(response.status).toBe(200);
      expect(isPidAlive(child.pid!)).toBe(false);
      expect(JSON.parse(readFileSync(join(target.sessionDir, 'session.json'), 'utf8')).recentRuns[0])
        .toMatchObject({ id: marker, outcome: 'interrupted', interruptRequestedAt: expect.any(String) });
      expect(getLaneEvents(target.laneId, 50).filter((event) => event.verb === 'kill_escalated'))
        .toEqual([expect.objectContaining({ payload: expect.objectContaining({ pid: child.pid, confirmed: true }) })]);
      expect(readOrchestratorControlPlaneState().packets[0].operatorStopped).toBe(true);
    });

    it('keeps identity-mismatched resumed workers held instead of claiming they exited', async () => {
      const child = await spawnWorker(randomUUID());
      const target = bindWorker(child.pid!, randomUUID(), child.pid!, 'sandbox-exec', runtime);
      recordPreviousExit(target);
      const response = await stopTarget(target);
      const body = await response.json();
      expect(entry === 'packet' ? response.status === 409 : body.ok === false).toBe(true);
      expect(isPidAlive(child.pid!)).toBe(true);
      expect(getLaneEvents(target.laneId, 50).filter((event) => event.verb === 'kill_escalated')).toEqual([]);
      expect(readOrchestratorControlPlaneState().packets[0].operatorStopped).toBe(true);
    });

    it.each(['prepared', 'missing', 'settled'] as const)('handles a %s saved run without stale exit proof', async (state) => {
      const target = bindWorker(0, randomUUID(), 0, 'sandbox-exec', runtime);
      recordPreviousExit(target);
      const sessionPath = join(target.sessionDir, 'session.json');
      const saved = JSON.parse(readFileSync(sessionPath, 'utf8'));
      if (state === 'prepared') saved.activeRun.spawnState = 'prepared';
      if (state === 'settled') saved.activeRun = null;
      if (state === 'missing') rmSync(sessionPath);
      else writeFileSync(sessionPath, JSON.stringify(saved));
      const response = await stopTarget(target);
      const body = await response.json();
      expect(body.ok).toBe(state === 'settled');
      if (state === 'settled' && entry === 'packet') {
        expect(body.result).toMatchObject({ interruptedSessions: 0, killConfirmed: true });
      }
      if (state !== 'settled' && entry === 'packet') expect(response.status).toBe(409);
      expect(getLaneEvents(target.laneId, 50).filter((event) => event.verb === 'kill_escalated')).toEqual([]);
      expect(readOrchestratorControlPlaneState().packets[0].operatorStopped).toBe(true);
    });
  });

  it('stops after wrapper exec and persists confirmed kill and operator hold', async () => {
    const marker = randomUUID();
    const child = await spawnWorker(marker);
    const target = bindWorker(child.pid!, marker);
    const response = await stop(target.packetId);
    expect(response.status).toBe(200);
    expect(isPidAlive(child.pid!)).toBe(false);
    expect(JSON.parse(readFileSync(join(target.sessionDir, 'session.json'), 'utf8')).recentRuns[0])
      .toMatchObject({ outcome: 'interrupted', interruptRequestedAt: expect.any(String) });
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
