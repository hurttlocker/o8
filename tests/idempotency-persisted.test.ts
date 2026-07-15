/**
 * Persisted idempotency (#1497), driven through the REAL rerun-with-feedback
 * route handler — the exact "green tests encode the premise" class this doctrine
 * exists for. We do NOT unit-test the store in isolation; we POST a constructed
 * Request to the actual route TWICE against a fresh DB and assert:
 *
 *   1. single execution + a replayed second response (the timeout+retry case),
 *   2. an in-flight duplicate is told "in progress, not re-executed" WITHOUT
 *      forking a second worker (the live incident — two parallel clones), and
 *   3. a simulated RESTART (closeDb → the route re-opens the same DB file) still
 *      dedupes, because the guard is persisted, not in-memory.
 *
 * The underlying dispatch service is mocked to a counter + a deferred promise so
 * we can hold a call "in flight"; everything above the mock is the real path.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Shared, hoisted so the vi.mock factory can see them.
const h = vi.hoisted(() => {
  let calls = 0;
  let deferred: { promise: Promise<unknown>; resolve: (v: unknown) => void } | null = null;
  return {
    state: {
      get calls() { return calls; },
      reset() { calls = 0; deferred = null; },
      /** Arm a deferred so the next rerun call blocks until resolveNext(). */
      arm() {
        let resolve!: (v: unknown) => void;
        const promise = new Promise<unknown>((r) => { resolve = r; });
        deferred = { promise, resolve };
      },
      resolveNext(v: unknown) { deferred?.resolve(v); },
    },
    impl: async (input: { packetId: string; feedback: string }) => {
      calls += 1;
      if (deferred) {
        await deferred.promise;
        deferred = null;
      }
      return { ok: true, packetId: input.packetId, dispatched: true, laneId: `lane-${calls}` };
    },
  };
});

vi.mock('@/lib/orchestrator/operator-mission-service', () => ({
  rerunWithFeedback: (input: { packetId: string; feedback: string }) => h.impl(input),
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-idempotency-'));
const WS_TOKEN = 'operator-ws-token-idem-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${WS_TOKEN}\n`, 'utf-8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const rerun = await import('@/app/api/orchestrator/rerun-with-feedback/route');
const { closeDb } = await import('@/lib/db');

const URL = 'http://localhost:3001/api/orchestrator/rerun-with-feedback';

function post(body: unknown): NextRequest {
  return new NextRequest(URL, {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${WS_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('persisted idempotency — rerun_with_feedback through the real route', () => {
  beforeEach(() => h.state.reset());

  it('a timeout+retry of the SAME call executes once and replays the second response', async () => {
    const body = { packetId: 'pkt-idem-1', feedback: 'typecheck failed; fix imports' };

    const first = await json(await rerun.POST(post(body)));
    expect(first.ok).toBe(true);
    expect((first.result as Record<string, unknown>).replayed).toBeUndefined();
    expect(h.state.calls).toBe(1);

    const second = await json(await rerun.POST(post(body)));
    expect(second.ok).toBe(true);
    // Replayed — did NOT execute a second time.
    expect((second.result as Record<string, unknown>).replayed).toBe(true);
    expect((second.result as Record<string, unknown>).laneId).toBe('lane-1');
    expect(h.state.calls).toBe(1);
  });

  it('an in-flight duplicate is told "in progress" and does NOT fork a second worker', async () => {
    const body = { packetId: 'pkt-idem-inflight', feedback: 'redo the migration' };
    h.state.arm(); // the first call will block until we resolve it

    const firstPromise = rerun.POST(post(body)); // reserves, then blocks in run()
    // Give the reserve INSERT time to land before the duplicate arrives.
    await new Promise((r) => setTimeout(r, 25));

    const dup = await json(await rerun.POST(post(body)));
    expect((dup.result as Record<string, unknown>).replayed).toBe(true);
    expect((dup.result as Record<string, unknown>).inProgress).toBe(true);
    expect((dup.result as Record<string, unknown>).status).toBe('in_progress');
    expect(h.state.calls).toBe(1); // the duplicate did not execute

    // Let the original finish; still exactly one execution.
    h.state.resolveNext(undefined);
    const first = await json(await firstPromise);
    expect((first.result as Record<string, unknown>).replayed).toBeUndefined();
    expect(h.state.calls).toBe(1);
  });

  it('survives a RESTART — a persisted key still dedupes after closeDb()', async () => {
    const body = { packetId: 'pkt-idem-restart', feedback: 'address review comments' };

    const first = await json(await rerun.POST(post(body)));
    expect((first.result as Record<string, unknown>).replayed).toBeUndefined();
    expect(h.state.calls).toBe(1);

    // Simulate a process restart: drop the in-memory DB singleton. The route
    // re-opens the SAME file (same data dir) on the next call.
    closeDb();

    const afterRestart = await json(await rerun.POST(post(body)));
    expect((afterRestart.result as Record<string, unknown>).replayed).toBe(true);
    expect(h.state.calls).toBe(1); // no re-execution across the restart
  });

  it('a DIFFERENT feedback body is a distinct key and executes', async () => {
    const a = await json(await rerun.POST(post({ packetId: 'pkt-idem-2', feedback: 'first' })));
    const b = await json(await rerun.POST(post({ packetId: 'pkt-idem-2', feedback: 'second — different' })));
    expect((a.result as Record<string, unknown>).replayed).toBeUndefined();
    expect((b.result as Record<string, unknown>).replayed).toBeUndefined();
    expect(h.state.calls).toBe(2);
  });
});
