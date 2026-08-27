import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createOpenCodeServiceFixture } from './helpers/opencode-service-fixture';

const h = vi.hoisted(() => ({
  publishRealtimeMutation: vi.fn(async () => true),
}));

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: h.publishRealtimeMutation,
}));

vi.mock('@/lib/lane/reap-sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/reap-sessions')>();
  return {
    ...actual,
    archiveLaneSessions: vi.fn(async () => ({ targeted: 0, archived: 0, outcomes: [], failures: [] })),
    killLaneSessionsConfirmed: vi.fn(async (lanes: Array<{ id: string; sessionKey: string | null; runtime: string }>) => (
      lanes.flatMap((lane) => lane.sessionKey ? [{
        laneId: lane.id,
        sessionKey: lane.sessionKey,
        runtime: lane.runtime,
        confirmed: false,
        alreadyDead: true,
        stages: [],
        note: 'already stopped in route test',
      }] : [])
    )),
  };
});

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-reset-lifecycle-'));
const operatorToken = 'operator-reset-lifecycle-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const route = await import('@/app/api/orchestrator/reset-packet/route');
const { closeDb } = await import('@/lib/db');
const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');

beforeEach(() => {
  h.publishRealtimeMutation.mockClear();
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

function createLinkedWorktree(prefix: string, branch: string) {
  const root = mkdtempSync(join(dataDir, prefix));
  const repoPath = join(root, 'repo');
  const worktreePath = join(root, 'worktree');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  git(root, 'init', '--initial-branch=main', repoPath);
  git(repoPath, '-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test',
    'commit', '--allow-empty', '-m', 'init');
  git(repoPath, 'worktree', 'add', '-b', branch, worktreePath);
  return { root, repoPath, worktreePath };
}

describe('reset lifecycle retirement through the operator route', () => {
  it('rejects an uncorrelated reset before touching packet state', async () => {
    const response = await route.POST(new NextRequest('http://localhost:3001/api/orchestrator/reset-packet', {
      method: 'POST',
      headers: {
        host: 'localhost:3001',
        authorization: `Bearer ${operatorToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ packetId: 'packet-without-mutation-id', clearWorktree: false }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'idempotency_key_required' },
    });
  });

  it('archives with the original session identity while clearing dispatch bindings', async () => {
    const packetId = 'packet-reset-lifecycle';
    const sessionKey = 'opencode-owned:reset-lifecycle';
    const lane = createLane({
      repoPath: '/tmp/o8-reset-lifecycle-repo',
      branch: 'inline/reset-lifecycle',
      runtime: 'opencode',
      packetId,
      sessionKey,
      worktreePath: '/tmp/o8-reset-lifecycle-worktree',
    });
    setLaneStatus(lane.id, 'running', 'system', 'route_reset_fixture');
    h.publishRealtimeMutation.mockClear();

    const request = () => new NextRequest('http://localhost:3001/api/orchestrator/reset-packet', {
      method: 'POST',
      headers: {
        host: 'localhost:3001',
        authorization: `Bearer ${operatorToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        packetId,
        clearWorktree: false,
        idempotencyKey: 'reset-lifecycle-route',
      }),
    });
    const response = await route.POST(request());

    expect(response.status).toBe(200);
    const archived = getLane(lane.id);
    expect(archived).toMatchObject({
      status: 'archived',
      packetId: '',
      sessionKey,
      worktreePath: null,
    });
    expect(h.publishRealtimeMutation).toHaveBeenCalledWith(expect.objectContaining({
      mutation: expect.objectContaining({
        action: 'lane-lifecycle',
        laneId: lane.id,
        laneStatus: 'archived',
        packetId: '',
        sessionKey,
      }),
    }));

    const replay = await route.POST(request());
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      ok: true,
      result: { replayed: true },
    });
    expect(h.publishRealtimeMutation).toHaveBeenCalledTimes(1);
  });

  it('releases the OpenCode service location before reset removes the worktree', { timeout: 20_000 }, async () => {
    const packetId = 'packet-reset-opencode-release';
    const branch = 'issue/reset-opencode-release';
    const { root, repoPath, worktreePath } = createLinkedWorktree('reset-opencode-', branch);
    const lane = createLane({
      repoPath,
      branch,
      runtime: 'opencode',
      packetId,
      worktreePath,
    });
    setLaneStatus(lane.id, 'failed', 'system', 'worker_completed');
    const fixture = createOpenCodeServiceFixture(root, worktreePath);
    const originalPath = process.env.PATH;
    const originalBinary = process.env.O8_OPENCODE_BIN;

    let response: Response;
    try {
      process.env.PATH = `${fixture.binDir}:${originalPath ?? ''}`;
      process.env.O8_OPENCODE_BIN = fixture.opencodeBin;
      response = await route.POST(new NextRequest('http://localhost:3001/api/orchestrator/reset-packet', {
        method: 'POST',
        headers: {
          host: 'localhost:3001',
          authorization: `Bearer ${operatorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          packetId,
          clearWorktree: true,
          idempotencyKey: 'reset-opencode-release-route',
        }),
      }));
    } finally {
      process.env.PATH = originalPath;
      if (originalBinary === undefined) delete process.env.O8_OPENCODE_BIN;
      else process.env.O8_OPENCODE_BIN = originalBinary;
    }

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: {
        reset: true,
        packetId,
        worktreePruned: true,
      },
    });
    expect(existsSync(worktreePath)).toBe(false);
    expect(getLane(lane.id)).toMatchObject({
      status: 'archived',
      packetId: '',
      worktreePath: null,
    });
    const calls = fixture.readLog();
    const releaseIndex = calls.findIndex((call) => call.startsWith('opencode api delete /api/debug/location?'));
    const removalProbeIndex = calls.findIndex((call) => call.startsWith('lsof -nP -d cwd'));
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(removalProbeIndex).toBeGreaterThan(releaseIndex);
  });
});
