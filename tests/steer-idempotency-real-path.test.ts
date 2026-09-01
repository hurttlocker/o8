import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  perform: vi.fn(),
  publish: vi.fn(async () => {}),
}));

vi.mock('@/lib/runtime/actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtime/actions')>();
  return { ...actual, performRuntimeAction: h.perform };
});
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: h.publish }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));
vi.mock('@/lib/runtime/inventory', () => ({
  getRuntimeInventorySnapshot: vi.fn(async () => ({ agents: [] })),
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-steer-idempotency-'));
const operatorToken = 'operator-steer-idempotency-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const legacyRoute = await import('@/app/api/orchestrator/steer-packet/route');
const operatorStatusRoute = await import('@/app/api/operator/status/route');
const { handleStatus } = await import('@/lib/mcp/operator-handlers/status');
const agentControlRoute = await import('@/app/api/agent-control/action/route');
const idempotency = await import('@/lib/orchestrator/idempotency-store');
const { closeDb, getSqlite } = await import('@/lib/db');
const { createLane, deleteLane, getLane } = await import('@/lib/lane/registry');

const createdLaneIds: string[] = [];

function post(pathname: string, body: unknown) {
  return new NextRequest(`http://localhost:3001${pathname}`, {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${operatorToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function createSteerLane(label: string, sessionKey = `codex-owned:${label}`) {
  const lane = createLane({
    repoPath: dataDir,
    branch: `inline/${label}`,
    runtime: 'codex',
    packetId: `packet-${label}`,
    sessionKey,
  });
  createdLaneIds.push(lane.id);
  return lane;
}

function steerEventCount(laneId: string): number {
  const row = getSqlite().prepare(
    "SELECT COUNT(*) AS count FROM lane_events WHERE lane_id = ? AND verb = 'steered_packet'",
  ).get(laneId) as { count: number };
  return row.count;
}

beforeEach(() => {
  h.perform.mockReset();
  h.publish.mockClear();
  idempotency.__resetIdempotencyStoreForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const laneId of createdLaneIds.splice(0)) deleteLane(laneId);
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('packet steer post-effect idempotency through real routes', () => {
  it('real o8_status keeps a successfully steered lane visible when runtime discovery is empty', async () => {
    const lane = createSteerLane(
      'operator-status-lane-truth',
      'test-runtime:operator-status-lane-truth',
    );
    h.perform.mockResolvedValueOnce({
      ok: true,
      action: 'steer',
      surfaceId: lane.sessionKey,
      sessionKey: lane.sessionKey,
      runtime: lane.runtime,
      status: 'sent',
      note: 'steered',
    });

    const steer = await legacyRoute.POST(post('/api/orchestrator/steer-packet', {
      packetId: lane.packetId,
      message: 'continue the live packet',
      idempotencyKey: 'operator-status-lane-truth',
    }));
    expect(steer.status).toBe(200);
    expect(getLane(lane.id)?.status).toBe('running');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = new NextRequest(String(input));
      if (request.nextUrl.pathname === '/api/operator/status') {
        return operatorStatusRoute.GET(request);
      }
      throw new Error(`Unexpected fetch: ${request.nextUrl.pathname}`);
    });

    const result = await handleStatus({});
    const text = result.content.find((block) => block.type === 'text')?.text ?? '{}';
    const payload = JSON.parse(text) as {
      summary: string;
      data: {
        agents: Array<{ sessionKey: string; status: string; authority: string }>;
        recentActivity: Array<{ action: string; target: string }>;
      };
    };

    expect(payload.summary).toContain('1 agent running');
    expect(payload.data.agents).toContainEqual(expect.objectContaining({
      sessionKey: lane.sessionKey,
      status: 'running',
      authority: 'lane-state',
    }));
    expect(payload.data.recentActivity).toContainEqual(expect.objectContaining({
      action: 'transcript_activity',
      target: lane.label,
    }));
  });

  it('legacy steer replays an outcome-unknown throw after the event/send boundary', async () => {
    const lane = createSteerLane('legacy-outcome-unknown');
    h.perform.mockImplementationOnce(async () => {
      throw new Error('transport closed after the provider may have accepted the steer');
    });
    const body = {
      packetId: lane.packetId,
      message: 'continue this exact turn once',
      idempotencyKey: 'legacy-steer-post-effect-once',
    };

    const first = await legacyRoute.POST(post('/api/orchestrator/steer-packet', body));
    const replay = await legacyRoute.POST(post('/api/orchestrator/steer-packet', body));

    expect(first.status).toBe(409);
    expect(first.headers.get('x-o8-steer-outcome')).toBe('unknown');
    await expect(first.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'steer_outcome_unknown',
        message: expect.stringContaining('inspect the session before sending it again'),
      },
    });
    expect(replay.status).toBe(409);
    expect(replay.headers.get('x-o8-idempotency-replayed')).toBe('1');
    expect(h.perform).toHaveBeenCalledTimes(1);
    expect(h.perform).toHaveBeenCalledWith(expect.objectContaining({
      clientMutationId: body.idempotencyKey,
    }));
    expect(steerEventCount(lane.id)).toBe(1);
  });

  it('AgentControl persists the same post-effect steer failure as manual truth', async () => {
    const lane = createSteerLane('agent-control-outcome-unknown');
    h.perform.mockImplementationOnce(async () => {
      throw new Error('provider response was lost after send');
    });
    const body = {
      ref: { kind: 'packet', id: lane.packetId },
      action: { kind: 'steer', message: 'send this packet steer once' },
      clientMutationId: 'agent-control-steer-post-effect-once',
    };

    const first = await agentControlRoute.POST(post('/api/agent-control/action', body));
    closeDb();
    const replay = await agentControlRoute.POST(post('/api/agent-control/action', body));

    expect(first.status).toBe(409);
    await expect(first.json()).resolves.toMatchObject({
      ok: false,
      result: {
        ok: false,
        status: 'unavailable',
        retryable: false,
        reason: 'steer_outcome_unknown',
        note: expect.stringContaining('inspect the session before sending it again'),
      },
    });
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({
      result: { reason: 'steer_outcome_unknown', replayed: true },
    });
    expect(h.perform).toHaveBeenCalledTimes(1);
    expect(h.perform).toHaveBeenCalledWith(expect.objectContaining({
      clientMutationId: body.clientMutationId,
    }));
    expect(steerEventCount(lane.id)).toBe(1);
  });

  it('replays a known terminal provider refusal after recording the steer event', async () => {
    const lane = createSteerLane('legacy-terminal-refusal');
    h.perform.mockResolvedValueOnce({
      ok: false,
      action: 'steer',
      surfaceId: lane.sessionKey,
      sessionKey: lane.sessionKey,
      runtime: lane.runtime,
      status: 'unavailable',
      note: 'The provider declined the steer.',
    });
    const body = {
      packetId: lane.packetId,
      message: 'do not retry this refused steer automatically',
      idempotencyKey: 'legacy-steer-terminal-once',
    };

    const first = await legacyRoute.POST(post('/api/orchestrator/steer-packet', body));
    const replay = await legacyRoute.POST(post('/api/orchestrator/steer-packet', body));

    expect(first.status).toBe(409);
    expect(first.headers.get('x-o8-steer-outcome')).toBe('terminal');
    await expect(first.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'steer_unavailable', message: 'The provider declined the steer.' },
    });
    expect(replay.status).toBe(409);
    expect(replay.headers.get('x-o8-idempotency-replayed')).toBe('1');
    expect(h.perform).toHaveBeenCalledTimes(1);
    expect(steerEventCount(lane.id)).toBe(1);
  });

  it('releases a provably pre-effect legacy reservation so the same key can retry', async () => {
    const body = {
      packetId: 'packet-that-does-not-exist',
      message: 'wait for a real session',
      idempotencyKey: 'legacy-steer-pre-effect-retry',
    };

    const first = await legacyRoute.POST(post('/api/orchestrator/steer-packet', body));
    const second = await legacyRoute.POST(post('/api/orchestrator/steer-packet', body));

    expect(first.status).toBe(500);
    expect(second.status).toBe(500);
    expect(second.headers.get('x-o8-idempotency-replayed')).toBeNull();
    const executionRows = getSqlite().prepare(
      "SELECT COUNT(*) AS count FROM idempotency_keys WHERE verb = 'steer_packet'",
    ).get() as { count: number };
    expect(executionRows.count).toBe(0);
    expect(h.perform).not.toHaveBeenCalled();
  });
});
