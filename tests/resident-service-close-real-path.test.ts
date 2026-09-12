import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { createOpenCodeServiceFixture } from './helpers/opencode-service-fixture';

vi.mock('@/lib/receipts/packet-receipt', () => ({
  createPacketReceiptForClosedPacket: async () => {},
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-resident-service-close-'));
const ownedRoot = join(dataDir, 'owned-runtime');
const wsToken = 'operator-resident-service-close-0123456789';
const originalEnv = {
  dataDir: process.env.CORTEX_IDE_DATA_DIR,
  o8DataDir: process.env.O8_DATA_DIR,
  ownedRoot: process.env.O8_OWNED_OPENCODE_ROOT,
};
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_OWNED_OPENCODE_ROOT = ownedRoot;
writeFileSync(join(dataDir, 'ws-token'), `${wsToken}\n`, 'utf8');

const closeRoute = await import('@/app/api/orchestrator/discard-packet/route');
const { closeDb } = await import('@/lib/db');
const { createLane, getLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { getOwnedOpencodeFleetAdditions, sweepOrphanedOpencodeSessions } = await import('@/lib/opencode/owned');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');

const roots: string[] = [];
const children: ChildProcess[] = [];

function restoreEnv(key: keyof typeof originalEnv, envName: string) {
  const value = originalEnv[key];
  if (value === undefined) delete process.env[envName];
  else process.env[envName] = value;
}

function operatorRequest(packetId: string) {
  return new NextRequest('http://localhost:3001/api/orchestrator/discard-packet', {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${wsToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      packetId,
      disposition: 'wontfix',
      clientMutationId: `resident-service-close-${randomUUID()}`,
    }),
  });
}

function createFixture(label: string, commandLine: string, options: { liveMarker?: string } = {}) {
  const root = mkdtempSync(join(dataDir, `${label}-`));
  const repoPath = join(root, 'repo');
  const worktreePath = join(root, 'worktree');
  const branch = `issue/${label}`;
  const packetId = `pkt-${label}`;
  const surfaceId = `opencode-owned:${label}`;
  roots.push(root);

  const run = (cwd: string, command: string, args: string[]) => {
    execFileSync(command, args, { cwd, stdio: 'pipe' });
  };
  run(root, 'git', ['init', '--initial-branch=main', repoPath]);
  run(repoPath, 'git', ['-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test',
    'commit', '--allow-empty', '-m', 'init']);
  run(repoPath, 'git', ['worktree', 'add', '-b', branch, worktreePath]);

  const service = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  if (!service.pid) throw new Error('Fixture service did not start.');
  children.push(service);

  const runtimeFixture = createOpenCodeServiceFixture(root, worktreePath);
  const psBin = join(runtimeFixture.binDir, 'ps');
  writeFileSync(psBin, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('-p') && args.includes(${JSON.stringify(String(service.pid))})) {
  process.stdout.write(${JSON.stringify(`${commandLine}\n`)});
  process.exit(0);
}
if (args.includes('-axo')) {
  process.stdout.write(${JSON.stringify(options.liveMarker
    ? `999 /opt/runtime/opencode2 run O8_OWNED_RUN_MARKER=${options.liveMarker}\n`
    : '')});
  process.exit(0);
}
process.exit(1);
`, 'utf8');
  chmodSync(psBin, 0o755);

  const sessionDir = join(ownedRoot, label);
  mkdirSync(join(sessionDir, 'runs'), { recursive: true });
  const timestamp = new Date().toISOString();
  writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
    surfaceId,
    sessionDir,
    cwd: worktreePath,
    repoPath,
    branch,
    title: label,
    createdAt: timestamp,
    updatedAt: timestamp,
    latestPrompt: 'fixture',
    latestSummary: 'fixture',
    recentRuns: [],
    activeRun: {
      id: `run-${label}`,
      mode: 'launch',
      prompt: 'fixture',
      startedAt: timestamp,
      pid: service.pid,
      processMarker: options.liveMarker,
      stdoutPath: join(sessionDir, 'runs', 'stdout.log'),
      stderrPath: join(sessionDir, 'runs', 'stderr.log'),
      outcome: 'running',
    },
  }), 'utf8');

  const lane = createLane({
    repoPath,
    worktreePath,
    branch,
    baseBranch: 'main',
    runtime: 'opencode',
    label,
    packetId,
    sessionKey: surfaceId,
  });
  setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    missionId: `mission-${label}`,
    repoPath,
    runtime: 'opencode',
    packets: [{
      id: packetId,
      referenceLabel: '#2224',
      title: label,
      summary: label,
      workspaceTargetPath: repoPath,
      branchTarget: branch,
      runtime: 'opencode',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'held',
      releaseState: 'pending',
      status: 'awaiting_review',
      blockedReason: null,
      lane: {
        tileId: lane.id,
        tabId: lane.id,
        repoPath,
        worktreePath,
        runtime: 'opencode',
        laneId: lane.id,
        sessionKey: surfaceId,
      },
      review: null,
    } as OrchestratorPacket],
    updatedAt: timestamp,
  });
  return { lane, packetId, repoPath, runtimeFixture, service, sessionDir, worktreePath };
}

async function closeWithFixture(fixture: ReturnType<typeof createFixture>) {
  const originalPath = process.env.PATH;
  const originalBinary = process.env.O8_OPENCODE_BIN;
  try {
    process.env.PATH = `${fixture.runtimeFixture.binDir}:${originalPath ?? ''}`;
    process.env.O8_OPENCODE_BIN = fixture.runtimeFixture.opencodeBin;
    return await closeRoute.POST(operatorRequest(fixture.packetId));
  } finally {
    process.env.PATH = originalPath;
    if (originalBinary === undefined) delete process.env.O8_OPENCODE_BIN;
    else process.env.O8_OPENCODE_BIN = originalBinary;
  }
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // The production path must not stop this fixture, but cleanup tolerates
        // an already-exited child so a failed assertion does not mask the test.
      }
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(`${ownedRoot}-archive`, { recursive: true, force: true });
  restoreEnv('dataDir', 'CORTEX_IDE_DATA_DIR');
  restoreEnv('o8DataDir', 'O8_DATA_DIR');
  restoreEnv('ownedRoot', 'O8_OWNED_OPENCODE_ROOT');
});

describe('discard packet through the resident-service process boundary', () => {
  it('closes a reviewing packet without signaling the resident service', async () => {
    const fixture = createFixture('resident-service', '/opt/runtime/opencode2 serve --service');

    const response = await closeWithFixture(fixture);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: {
        closed: true,
        worktreeRemoved: false,
        worktreeCleanup: 'preserved',
        note: expect.stringContaining('Kill unconfirmed'),
      },
    });
    expect(() => process.kill(fixture.service.pid!, 0)).not.toThrow();
    expect(existsSync(fixture.worktreePath)).toBe(true);
    expect(existsSync(fixture.sessionDir)).toBe(true);
    expect(getLane(fixture.lane.id)?.status).toBe('archived');
    expect(getLaneEvents(fixture.lane.id).find((event) => (
      event.verb === 'update' && event.payload.code === 'kill_unconfirmed'
    ))).toMatchObject({ payload: { note: expect.stringContaining('resident service') } });
    expect((await getOwnedOpencodeFleetAdditions({ fresh: true })).agents).toEqual([]);
    expect(await sweepOrphanedOpencodeSessions(new Set(), 0)).toBe(0);
    expect(JSON.parse(readFileSync(join(fixture.sessionDir, 'session.json'), 'utf8'))).toMatchObject({
      detachedAt: expect.any(String),
      detachedReason: expect.stringContaining('worker exit remained unconfirmed'),
    });
  });

  it('closes with kill_unconfirmed recorded and preserves the checkout', async () => {
    const fixture = createFixture('unconfirmed-worker', '/opt/runtime/opencode2 run --standalone');

    const response = await closeWithFixture(fixture);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: {
        closed: true,
        worktreeRemoved: false,
        worktreeCleanup: 'preserved',
        note: expect.stringContaining('Kill unconfirmed'),
      },
    });
    expect(existsSync(fixture.worktreePath)).toBe(true);
    expect(getLane(fixture.lane.id)).toMatchObject({
      status: 'archived',
      outcomeNote: expect.stringContaining('Kill unconfirmed'),
    });
    expect(readOrchestratorControlPlaneState().packets[0]?.status).toBe('archived');
    expect(existsSync(fixture.sessionDir)).toBe(true);
    expect(getLaneEvents(fixture.lane.id).find((event) => (
      event.verb === 'update' && event.payload.code === 'kill_unconfirmed'
    ))).toMatchObject({ payload: { resolution: 'closed_unmerged_worker_ownership_preserved' } });
  });

  it('preserves a marker-bearing worker when its recorded pid was reused by the service', async () => {
    const fixture = createFixture(
      'resident-service-reused-pid',
      '/opt/runtime/opencode2 serve --service',
      { liveMarker: 'worker-marker-reused-pid' },
    );

    const response = await closeWithFixture(fixture);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: {
        closed: true,
        worktreeCleanup: 'preserved',
        note: expect.stringContaining('Kill unconfirmed'),
      },
    });
    expect(existsSync(fixture.worktreePath)).toBe(true);
    expect(existsSync(fixture.sessionDir)).toBe(true);
    expect(() => process.kill(fixture.service.pid!, 0)).not.toThrow();
  });

  it('does not record closure when an unconfirmed worker still fails the missing-worktree gate', async () => {
    const fixture = createFixture('unconfirmed-missing', '/opt/runtime/opencode2 run --standalone');
    rmSync(fixture.worktreePath, { recursive: true, force: true });

    const response = await closeWithFixture(fixture);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'worktree_missing_unverified' },
    });
    expect(getLaneEvents(fixture.lane.id).some((event) => (
      event.verb === 'update' && event.payload.code === 'kill_unconfirmed'
    ))).toBe(false);
  });
});
