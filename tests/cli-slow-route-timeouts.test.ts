import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_API_TIMEOUT_MS,
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

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CLI slow-route timeout policy', () => {
  it('gives every packet merge call a five-minute response window', async () => {
    const fetchMock = installRouteFetch();

    await runPacketReview(mode, ['pkt-slow-route', '--approve']);
    await runPacketApproveMerge(mode, ['pkt-slow-route', '--as-operator']);

    expect(routeTimeouts(fetchMock, '/api/orchestrator/merge'))
      .toEqual([SLOW_MUTATION_TIMEOUT_MS, SLOW_MUTATION_TIMEOUT_MS]);
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
    await runPacketSteer(mode, ['pkt-slow-route', '--message', 'continue']);

    expect(routeTimeouts(fetchMock, '/api/orchestrator/reset-packet'))
      .toEqual([SLOW_MUTATION_TIMEOUT_MS, SLOW_MUTATION_TIMEOUT_MS]);
    expect(routeTimeouts(fetchMock, '/api/orchestrator/rerun-with-feedback'))
      .toEqual([SLOW_MUTATION_TIMEOUT_MS]);
    expect(routeTimeouts(fetchMock, '/api/orchestrator/steer-packet'))
      .toEqual([SLOW_MUTATION_TIMEOUT_MS]);
  });

  it('extends mission dispatch only when the caller requests synchronous launch', async () => {
    const fetchMock = installRouteFetch();

    await runMission(mode, 'dispatch', []);
    await runMission(mode, 'dispatch', ['--wait']);

    expect(routeTimeouts(fetchMock, '/api/orchestrator/dispatch'))
      .toEqual([DEFAULT_API_TIMEOUT_MS, SLOW_MUTATION_TIMEOUT_MS]);
  });
});
