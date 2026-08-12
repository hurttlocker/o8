import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import { NextRequest } from 'next/server';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

const worktreeFailure = vi.hoisted(() => ({
  enabled: false,
  message: 'synthetic packet worktree provision failure',
}));

vi.mock('@/lib/worktree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/worktree')>();
  return {
    ...actual,
    prepareLaunchWorktree: async (
      options: Parameters<typeof actual.prepareLaunchWorktree>[0],
    ) => {
      if (worktreeFailure.enabled) {
        throw new Error(worktreeFailure.message);
      }
      return actual.prepareLaunchWorktree(options);
    },
  };
});

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));

vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({
  ensureDispatchBackendReady: vi.fn(async () => ({
    ready: true,
    reason: 'test',
    waitedMs: 0,
    attempts: 1,
    lastCheck: {
      ready: true,
      reason: 'test',
      apiBase: 'http://127.0.0.1:1',
      portSource: 'default',
      apiPortFilePresent: false,
    },
  })),
}));

vi.mock('@/lib/analytics/server', () => ({
  emitProductEvent: vi.fn(async () => undefined),
}));

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => undefined),
}));

const root = mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'declarative-dispatch-real-path-'));
const dataDir = join(root, 'data');
const ownedRoot = join(root, 'owned-qoder');
const capturePath = join(root, 'qoder-spawns.jsonl');
const fakeQoderPath = join(root, 'qodercli');
const priorEnv = new Map<string, string | undefined>();
const envKeys = [
  'CORTEX_IDE_DATA_DIR',
  'O8_DATA_DIR',
  'O8_OWNED_QODER_ROOT',
  'O8_QODER_BIN',
  'O8_FAKE_QODER_CAPTURE',
  'O8_CRASH_SURVIVABLE_WORKERS',
  'O8_SKIP_PRELAUNCH_TYPECHECK',
] as const;

for (const key of envKeys) priorEnv.set(key, process.env[key]);
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_OWNED_QODER_ROOT = ownedRoot;
process.env.O8_QODER_BIN = fakeQoderPath;
process.env.O8_FAKE_QODER_CAPTURE = capturePath;
process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

writeFileSync(
  fakeQoderPath,
  [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "if (process.argv.includes('--version')) {",
    "  process.stdout.write('qodercli 1.0.0\\n');",
    '  process.exit(0);',
    '}',
    'fs.appendFileSync(',
    '  process.env.O8_FAKE_QODER_CAPTURE,',
    "  `${JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) })}\\n`,",
    ');',
    "process.stderr.write('fake qoder fatal exit\\n');",
    'setTimeout(() => process.exit(23), 25);',
  ].join('\n'),
  'utf8',
);
chmodSync(fakeQoderPath, 0o755);

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function createRemoteBackedRepo(): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  const origin = join(root, `origin-${suffix}.git`);
  const seed = join(root, `seed-${suffix}`);
  const repo = join(root, `repo-${suffix}`);
  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, seed], { stdio: 'pipe' });
  git(seed, 'checkout', '-b', 'main');
  writeFileSync(join(seed, 'README.md'), 'declarative dispatch test\n', 'utf8');
  git(seed, 'add', 'README.md');
  git(seed, '-c', 'user.name=o8 test', '-c', 'user.email=o8@test.invalid', 'commit', '-m', 'init');
  git(seed, 'push', '-u', 'origin', 'main');
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  return repo;
}

function packet(repoPath: string, id: string): OrchestratorPacket {
  return {
    id,
    referenceLabel: id.toUpperCase(),
    title: `packet ${id}`,
    summary: `exercise declarative dispatch ${id}`,
    workspaceTargetPath: repoPath,
    branchTarget: `packet/${id}`,
    runtime: 'qoder',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    blockedReason: null,
    lane: null,
    review: null,
    workerRouting: {
      requestedRuntime: 'qoder',
    } as OrchestratorPacket['workerRouting'],
  };
}

function mission(repoPath: string, target: OrchestratorPacket): OrchestratorMissionState {
  return {
    missionId: `mission-${target.id}`,
    repoPath,
    packets: [target],
    updatedAt: new Date().toISOString(),
  } as OrchestratorMissionState;
}

async function waitFor<T>(
  read: () => T | null,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

describe('declarative packet dispatch worktree reachability', () => {
  beforeEach(() => {
    worktreeFailure.enabled = false;
  });

  afterAll(async () => {
    const { closeDb } = await import('@/lib/db');
    closeDb();
    vi.unstubAllGlobals();
    for (const [key, value] of priorEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('spawns in the packet worktree, reports process death, and blocks when provisioning fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const repoPath = createRemoteBackedRepo();
    const [{ runDispatchTick }, laneRegistry] = await Promise.all([
      import('@/lib/orchestrator/scheduling'),
      import('@/lib/lane/registry'),
    ]);

    const successId = 'pkt-declarative-cwd';
    const launched = await runDispatchTick(mission(repoPath, packet(repoPath, successId)), {
      launchBudget: { maxLaunches: 1 },
    });
    const launchedPacket = launched.packets[0];
    const launchedLane = laneRegistry.findLaneByPacket(successId);
    expect(launchedPacket.status).toBe('launching');

    const spawn = await waitFor(() => {
      if (!existsSync(capturePath)) return null;
      const line = readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean)[0];
      return line ? JSON.parse(line) as { cwd: string; argv: string[] } : null;
    }, 'fake qoder spawn');
    expect(realpathSync(spawn.cwd)).not.toBe(realpathSync(repoPath));
    expect(launchedLane?.worktreePath).toBeTruthy();
    expect(launchedPacket.lane?.worktreePath).toBe(launchedLane?.worktreePath);
    const worktreePath = realpathSync(launchedLane!.worktreePath!);
    expect(realpathSync(spawn.cwd)).toBe(worktreePath);
    expect(worktreePath).not.toBe(realpathSync(repoPath));
    expect(worktreePath).toContain(`${sep}.cortex-worktrees${sep}packet-${successId}`);

    const exitEvent = await waitFor(() => {
      const event = laneRegistry.getLaneEvents(launchedLane!.id, 200)
        .find((candidate) => candidate.verb === 'runtime_process_exit');
      return event ?? null;
    }, 'runtime_process_exit lane event');
    expect(exitEvent.payload).toMatchObject({
      runtime: 'qoder',
      exitCode: 23,
      signal: null,
      classification: 'nonzero-exit',
      completedTurn: false,
    });
    expect(exitEvent.payload.stderr).toContain('fake qoder fatal exit');

    const captureBeforeFailure = readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean);
    worktreeFailure.enabled = true;
    const failureId = 'pkt-declarative-worktree-failure';
    const blocked = await runDispatchTick(mission(repoPath, packet(repoPath, failureId)), {
      launchBudget: { maxLaunches: 1 },
    });
    const blockedPacket = blocked.packets[0];
    const blockedLane = laneRegistry.findLatestLaneByPacket(failureId);
    expect(blockedPacket.status).toBe('blocked');
    expect(blockedPacket.blockedReason).toContain('packet_worktree_provision_failed');
    expect(blockedPacket.blockedReason).toContain(worktreeFailure.message);
    expect(blockedLane?.status).toBe('failed');
    expect(laneRegistry.getLaneEvents(blockedLane!.id, 200)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        verb: 'worktree_provision_failed',
        payload: expect.objectContaining({
          code: 'packet_worktree_provision_failed',
          runtime: 'qoder',
          packetId: failureId,
        }),
      }),
    ]));
    const captureAfterFailure = readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean);
    expect(captureAfterFailure).toEqual(captureBeforeFailure);
  }, 40_000);

  it('rolls back a launched worker when the real route cannot persist its governance lane', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const repoPath = createRemoteBackedRepo();
    const laneRegistry = await import('@/lib/lane/registry');
    const { getRuntime } = await import('@/lib/runtimes');
    const runtime = getRuntime('qoder')!;
    const sessionsBefore = new Set((await runtime.discoverSessions()).map((session) => session.sessionKey));
    const createLane = vi.spyOn(laneRegistry, 'createLane').mockImplementationOnce(() => {
      throw new Error('synthetic lane persistence failure');
    });
    try {
      const { POST } = await import('@/app/api/runtime/launch/route');
      const response = await POST(new NextRequest('http://localhost/api/runtime/launch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runtime: 'qoder',
          prompt: 'prove launch rollback',
          repoPath,
          isolate: true,
          clientMutationId: 'runtime-launch-lane-failure',
        }),
      }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        surfaceId: expect.stringMatching(/^qoder-owned:/),
        note: expect.stringContaining('governance lane could not be persisted'),
      });
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const extra = (await runtime.discoverSessions())
          .filter((session) => !sessionsBefore.has(session.sessionKey));
        if (extra.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect((await runtime.discoverSessions())
        .filter((session) => !sessionsBefore.has(session.sessionKey))).toEqual([]);
      const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repoPath,
        encoding: 'utf8',
      });
      expect(worktrees.match(/^worktree /gm)).toHaveLength(1);
    } finally {
      createLane.mockRestore();
    }
  }, 40_000);
});
