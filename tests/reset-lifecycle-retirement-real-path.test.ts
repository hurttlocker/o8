import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

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
});
