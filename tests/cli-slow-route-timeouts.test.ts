import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SLOW_MUTATION_TIMEOUT_MS,
} from '../cli/src/api';
import { ASK_API_TIMEOUT_MS, runAsk } from '../cli/src/commands/ask';
import { runMission } from '../cli/src/commands/mission';
import {
  runPacketApproveMerge,
  runPacketRerun,
  runPacketReset,
  runPacketRetry,
  runPacketSteer,
} from '../cli/src/commands/packet/recover';
import { runPacketReview } from '../cli/src/commands/packet/review';

const mode = { human: false, verbose: false };
let timeoutBySignal: Map<AbortSignal, number>;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installRouteFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/lanes') {
      return jsonResponse({
        lanes: [{
          id: 'lane-slow-route',
          packetId: 'pkt-slow-route',
          worktreePath: '/repo/.cortex-worktrees/packet-slow-route',
          status: 'running',
        }],
      });
    }
    if (path === '/api/cortex/ask/answer') {
      return jsonResponse({ ok: true, answer: 'Use the canonical seam.', citations: [] });
    }
    if (path === '/api/orchestrator/review') {
      return jsonResponse({ ok: true, result: { recorded: true, reviewedHeadSha: 'abc123' } });
    }
    if (path === '/api/orchestrator/merge') {
      return jsonResponse({ ok: true, result: { merged: true, note: 'merged' } });
    }
    if (path === '/api/orchestrator/dispatch') {
      return jsonResponse({
        ok: true,
        result: { initiated: true, dispatched: 1, missionId: 'mission-slow-route' },
      });
    }
    if (path === '/api/orchestrator/steer-packet') {
      return jsonResponse({ ok: true, result: { laneId: 'lane-slow-route', note: 'steered' } });
    }
    if (path === '/api/orchestrator/reset-packet' || path === '/api/orchestrator/rerun-with-feedback') {
      return jsonResponse({ ok: true, result: {} });
    }
    throw new Error(`Unexpected fetch path: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function routeTimeouts(fetchMock: ReturnType<typeof vi.fn>, path: string): number[] {
  return fetchMock.mock.calls
    .filter(([input]) => new URL(String(input)).pathname === path)
    .map(([, init]) => timeoutBySignal.get((init as RequestInit | undefined)?.signal as AbortSignal))
    .filter((timeout): timeout is number => timeout !== undefined);
}

beforeEach(() => {
  timeoutBySignal = new Map();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((timeout) => {
    const signal = new AbortController().signal;
    timeoutBySignal.set(signal, timeout);
    return signal;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CLI slow-route timeout policy', () => {
  it('replays the exact rerun body after an ambiguous transport loss', async () => {
    vi.useFakeTimers();
    const mutationBodies: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/lanes') {
        return jsonResponse({
          lanes: [{
            id: 'lane-slow-route',
            packetId: 'pkt-slow-route',
            worktreePath: '/repo/.cortex-worktrees/packet-slow-route',
            status: 'running',
          }],
        });
      }
      if (path === '/api/orchestrator/rerun-with-feedback') {
        mutationBodies.push(String(init?.body));
        if (mutationBodies.length === 1) throw new TypeError('socket closed');
        return jsonResponse({ ok: true, result: { note: 'relaunched once' } });
      }
      throw new Error(`Unexpected fetch path: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const request = runPacketRerun(mode, [
      'pkt-slow-route',
      '--feedback',
      'try again',
      '--idempotency-key',
      'cli-rerun-exact-retry',
    ]);
    await vi.advanceTimersByTimeAsync(250);
    await expect(request).resolves.toBe(0);

    expect(mutationBodies).toHaveLength(2);
    expect(mutationBodies[0]).toBe(mutationBodies[1]);
    expect(JSON.parse(mutationBodies[0])).toMatchObject({
      idempotencyKey: 'cli-rerun-exact-retry',
    });
  });

  it('polls accepted packet duplicates to terminal receipts with the exact request body', async () => {
    const mutationCalls = new Map<string, number>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/lanes') {
        return jsonResponse({
          lanes: [{
            id: 'lane-slow-route',
            packetId: 'pkt-slow-route',
            worktreePath: '/repo/.cortex-worktrees/packet-slow-route',
            status: 'running',
          }],
        });
      }
      if (path === '/api/orchestrator/review') {
        return jsonResponse({ ok: true, result: { recorded: true, reviewedHeadSha: 'abc123' } });
      }
      if (
        path === '/api/orchestrator/rerun-with-feedback'
        || path === '/api/orchestrator/steer-packet'
        || path === '/api/orchestrator/merge'
      ) {
        const requestBody = String(init?.body);
        const correlation = `${path}:${requestBody}`;
        const count = (mutationCalls.get(correlation) ?? 0) + 1;
        mutationCalls.set(correlation, count);
        if (count === 1) {
          return jsonResponse({
            ok: true,
            result: {
              replayed: true,
              inProgress: true,
              status: 'in_progress',
              note: 'The original operation is still running.',
            },
          }, 202);
        }
        return jsonResponse({
          ok: true,
          result: {
            laneId: path.includes('steer') ? 'lane-slow-route' : undefined,
            merged: path.includes('merge') ? true : undefined,
            note: 'The original operation completed.',
          },
        });
      }
      if (path === '/api/orchestrator/dispatch') {
        const requestBody = String(init?.body);
        const correlation = `${path}:${requestBody}`;
        const count = (mutationCalls.get(correlation) ?? 0) + 1;
        mutationCalls.set(correlation, count);
        return count === 1
          ? jsonResponse({
              ok: true,
              result: {
                replayed: true,
                inProgress: true,
                status: 'in_progress',
                note: 'The original operation is still running.',
              },
            }, 202)
          : jsonResponse({
              ok: true,
              result: { initiated: true, dispatched: 1, missionId: 'mission-slow-route' },
            });
      }
      throw new Error(`Unexpected fetch path: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const human = { human: true, verbose: false };

    await runPacketRerun(human, ['pkt-slow-route', '--feedback', 'try again']);
    await runPacketSteer(human, ['pkt-slow-route', '--message', 'continue']);
    await runPacketApproveMerge(human, ['pkt-slow-route', '--as-operator']);
    await runPacketReview(human, ['pkt-slow-route', '--approve']);
    await runMission(human, 'dispatch', ['--mission', 'mission-slow-route', '--wait']);

    const output = vi.mocked(process.stdout.write).mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain('relaunched');
    expect(output).toContain('steered');
    expect(output).toContain('merged');
    expect(output).toContain('dispatched 1 packet(s)');

    for (const path of [
      '/api/orchestrator/rerun-with-feedback',
      '/api/orchestrator/steer-packet',
    ]) {
      const bodies = fetchMock.mock.calls
        .filter(([input]) => new URL(String(input)).pathname === path)
        .map(([, init]) => String((init as RequestInit).body));
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toBe(bodies[1]);
    }
    const mergeBodies = fetchMock.mock.calls
      .filter(([input]) => new URL(String(input)).pathname === '/api/orchestrator/merge')
      .map(([, init]) => String((init as RequestInit).body));
    expect(mergeBodies).toHaveLength(4);
    expect(mergeBodies[0]).toBe(mergeBodies[1]);
    expect(mergeBodies[2]).toBe(mergeBodies[3]);
    expect(mergeBodies[0]).not.toBe(mergeBodies[2]);
    const dispatchBodies = fetchMock.mock.calls
      .filter(([input]) => new URL(String(input)).pathname === '/api/orchestrator/dispatch')
      .map(([, init]) => String((init as RequestInit).body));
    expect(dispatchBodies).toHaveLength(2);
    expect(dispatchBodies[0]).toBe(dispatchBodies[1]);
  }, 10_000);

  it('gives every packet merge call a five-minute response window', async () => {
    const fetchMock = installRouteFetch();

    await runPacketReview(mode, [
      'pkt-slow-route',
      '--approve',
      '--idempotency-key',
      'cli-review-merge-exact-retry',
    ]);
    await runPacketApproveMerge(mode, [
      'pkt-slow-route',
      '--as-operator',
      '--idempotency-key',
      'cli-approve-merge-exact-retry',
    ]);

    expect(routeTimeouts(fetchMock, '/api/orchestrator/merge'))
      .toEqual([SLOW_MUTATION_TIMEOUT_MS, SLOW_MUTATION_TIMEOUT_MS]);
    const mergeBodies = fetchMock.mock.calls
      .filter(([input]) => new URL(String(input)).pathname === '/api/orchestrator/merge')
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { idempotencyKey?: unknown });
    expect(mergeBodies.map((body) => body.idempotencyKey)).toEqual([
      'cli-review-merge-exact-retry',
      'cli-approve-merge-exact-retry',
    ]);
  });

  it('gives o8 ask explicit headroom beyond the server ninety-second timeout', async () => {
    const fetchMock = installRouteFetch();

    await runAsk(mode, ['What is the canonical seam?']);

    expect(ASK_API_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    expect(routeTimeouts(fetchMock, '/api/cortex/ask/answer')).toEqual([ASK_API_TIMEOUT_MS]);
  });

  it('gives synchronous recovery mutations a five-minute response window', async () => {
    const fetchMock = installRouteFetch();

    await runPacketReset(mode, ['pkt-slow-route']);
    await runPacketRetry(mode, ['pkt-slow-route']);
    await runPacketRerun(mode, ['pkt-slow-route', '--feedback', 'try again']);
    await runPacketRerun(mode, ['pkt-slow-route', '--feedback', 'try again']);
    await runPacketSteer(mode, ['pkt-slow-route', '--message', 'continue']);
    await runPacketSteer(mode, ['pkt-slow-route', '--message', 'continue']);

    expect(routeTimeouts(fetchMock, '/api/orchestrator/reset-packet'))
      .toEqual([SLOW_MUTATION_TIMEOUT_MS, SLOW_MUTATION_TIMEOUT_MS]);
    const resetBodies = fetchMock.mock.calls
      .filter(([input]) => new URL(String(input)).pathname === '/api/orchestrator/reset-packet')
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { idempotencyKey?: unknown });
    expect(resetBodies.map((body) => body.idempotencyKey)).toEqual([
      expect.any(String),
      expect.any(String),
    ]);
    expect(resetBodies[0].idempotencyKey).not.toBe(resetBodies[1].idempotencyKey);
    expect(routeTimeouts(fetchMock, '/api/orchestrator/rerun-with-feedback'))
      .toEqual([SLOW_MUTATION_TIMEOUT_MS, SLOW_MUTATION_TIMEOUT_MS]);
    const rerunBodies = fetchMock.mock.calls
      .filter(([input]) => new URL(String(input)).pathname === '/api/orchestrator/rerun-with-feedback')
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { idempotencyKey?: unknown });
    expect(rerunBodies.map((body) => body.idempotencyKey)).toEqual([
      expect.any(String),
      expect.any(String),
    ]);
    expect(rerunBodies[0].idempotencyKey).not.toBe(rerunBodies[1].idempotencyKey);
    expect(routeTimeouts(fetchMock, '/api/orchestrator/steer-packet'))
      .toEqual([SLOW_MUTATION_TIMEOUT_MS, SLOW_MUTATION_TIMEOUT_MS]);
    const steerBodies = fetchMock.mock.calls
      .filter(([input]) => new URL(String(input)).pathname === '/api/orchestrator/steer-packet')
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { idempotencyKey?: unknown });
    expect(steerBodies.map((body) => body.idempotencyKey)).toEqual([
      expect.any(String),
      expect.any(String),
    ]);
    expect(steerBodies[0].idempotencyKey).not.toBe(steerBodies[1].idempotencyKey);
  });

  it('extends mission dispatch only when the caller requests synchronous launch', async () => {
    const fetchMock = installRouteFetch();

    await runMission(mode, 'dispatch', []);
    await runMission(mode, 'dispatch', ['--wait']);

    expect(routeTimeouts(fetchMock, '/api/orchestrator/dispatch'))
      .toEqual([SLOW_MUTATION_TIMEOUT_MS, SLOW_MUTATION_TIMEOUT_MS]);
  });

  it.each([
    ['async', []],
    ['wait', ['--wait']],
  ] as const)('polls one exact mission dispatch body through transport loss and 202 in %s mode', async (_label, args) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('socket closed after admission'))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { inProgress: true } }, 202))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        result: { initiated: true, dispatched: 1, missionId: 'mission-correlated-dispatch' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = runMission(mode, 'dispatch', [...args]);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const bodies = fetchMock.mock.calls.map(([, init]) => String((init as RequestInit).body));
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toMatchObject({
      wait: args.length > 0,
      idempotencyKey: expect.any(String),
    });
  });
});
