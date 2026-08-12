import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { fetchCorrelatedPacketMutation } from '../cli/src/commands/packet/correlated-mutation';
import type { ResolvedConfig } from '../cli/src/config';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  deferred: null as PromiseWithResolvers<void> | null,
  partial: false,
}));

vi.mock('@/lib/orchestrator/mission-stop', () => ({
  stopMission: vi.fn(async (missionId: string) => {
    h.calls.push('packet-settled');
    h.calls.push('packet-partial');
    if (h.deferred) await h.deferred.promise;
    return {
      missionId,
      event: { type: 'mission_stop' as const, recordedAt: '2026-08-12T12:00:00.000Z' },
      packets: [
        {
          packetId: 'packet-settled',
          status: 'stopped' as const,
          laneId: 'lane-settled',
          note: 'Stopped.',
        },
        {
          packetId: 'packet-partial',
          status: h.partial ? 'stop-failed' as const : 'stopped' as const,
          laneId: 'lane-partial',
          note: h.partial ? 'Runtime remained live.' : 'Stopped.',
        },
      ],
    };
  }),
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-mission-stop-receipt-'));
const operatorToken = 'operator-mission-stop-receipt-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const route = await import('@/app/api/orchestrator/stop-mission/route');
const { __resetIdempotencyStoreForTests } = await import('@/lib/orchestrator/idempotency-store');
const { closeDb } = await import('@/lib/db');
const cliConfig: ResolvedConfig = {
  apiPort: 3001,
  apiBase: 'http://localhost:3001',
  token: operatorToken,
  workerPacketId: null,
  source: { port: 'default', token: 'env' },
  dataDir,
};

function post(idempotencyKey: string, missionId = 'mission-receipt') {
  return new NextRequest('http://localhost:3001/api/orchestrator/stop-mission', {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${operatorToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ missionId, idempotencyKey }),
  });
}

beforeEach(() => {
  h.calls.length = 0;
  h.deferred = null;
  h.partial = false;
  __resetIdempotencyStoreForTests();
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('mission-stop exact receipts through the real route', () => {
  it('replays a terminal partial receipt after the first response is lost', async () => {
    h.partial = true;
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body);
      bodies.push(body);
      const response = await route.POST(new NextRequest(
        'http://localhost:3001/api/orchestrator/stop-mission',
        {
          method: 'POST',
          headers: {
            host: 'localhost:3001',
            authorization: `Bearer ${operatorToken}`,
            'content-type': 'application/json',
          },
          body,
        },
      ));
      if (fetchMock.mock.calls.length === 1) {
        // The handler settled and persisted both packet outcomes, then the
        // transport disappeared before the caller could read its response.
        throw new TypeError('socket closed after response');
      }
      return response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const replay = await fetchCorrelatedPacketMutation<{
      ok: boolean;
      replayed?: boolean;
      error?: { code?: string };
      result?: {
        missionId: string;
        packets: Array<{ packetId: string; status: string }>;
      };
    }>(cliConfig, '/api/orchestrator/stop-mission', {
      missionId: 'mission-receipt',
      idempotencyKey: 'mission-stop-partial-key',
    }, { allowConflict: true, pollMs: 1 });

    expect(replay.status).toBe(409);
    expect(replay.data).toMatchObject({
      ok: false,
      replayed: true,
      error: { code: 'mission_stop_incomplete' },
      result: {
        missionId: 'mission-receipt',
        packets: [
          { packetId: 'packet-settled', status: 'stopped' },
          { packetId: 'packet-partial', status: 'stop-failed' },
        ],
      },
    });
    expect(bodies[1]).toBe(bodies[0]);
    expect(h.calls).toEqual(['packet-settled', 'packet-partial']);
  });

  it('returns 202 for a live duplicate and later replays the terminal receipt', async () => {
    h.deferred = Promise.withResolvers<void>();
    const first = route.POST(post('mission-stop-live-key'));
    await vi.waitFor(() => expect(h.calls).toEqual(['packet-settled', 'packet-partial']));

    const duplicate = await route.POST(post('mission-stop-live-key'));
    expect(duplicate.status).toBe(202);
    await expect(duplicate.json()).resolves.toMatchObject({
      ok: true,
      result: { inProgress: true, status: 'in_progress', replayed: true },
    });
    expect(h.calls).toEqual(['packet-settled', 'packet-partial']);

    h.deferred.resolve();
    expect((await first).status).toBe(200);
    const terminalReplay = await route.POST(post('mission-stop-live-key'));
    expect(terminalReplay.status).toBe(200);
    await expect(terminalReplay.json()).resolves.toMatchObject({
      ok: true,
      result: { missionId: 'mission-receipt', replayed: true },
    });
    expect(h.calls).toEqual(['packet-settled', 'packet-partial']);
  });

  it('rejects reusing one correlation id for another mission body', async () => {
    expect((await route.POST(post('mission-stop-bound-key'))).status).toBe(200);
    const conflict = await route.POST(post('mission-stop-bound-key', 'mission-other'));

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'idempotency_key_conflict' },
    });
    expect(h.calls).toEqual(['packet-settled', 'packet-partial']);
  });
});
