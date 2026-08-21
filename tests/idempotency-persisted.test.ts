/**
 * Persisted idempotency (#1497), driven through the REAL rerun-with-feedback
 * and steer-packet route handlers. We do NOT unit-test the store in isolation;
 * we POST constructed requests to the actual routes against a fresh DB and assert:
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
  let dispatchCalls = 0;
  let resetCalls = 0;
  let steerCalls = 0;
  let deferred: { promise: Promise<unknown>; resolve: (v: unknown) => void } | null = null;
  let dispatchDeferred: { promise: Promise<unknown>; resolve: (v: unknown) => void } | null = null;
  let steerDeferred: { promise: Promise<unknown>; resolve: (v: unknown) => void } | null = null;
  return {
    state: {
      get calls() { return calls; },
      get dispatchCalls() { return dispatchCalls; },
      get resetCalls() { return resetCalls; },
      get steerCalls() { return steerCalls; },
      reset() {
        calls = 0;
        dispatchCalls = 0;
        resetCalls = 0;
        steerCalls = 0;
        deferred = null;
        dispatchDeferred = null;
        steerDeferred = null;
      },
      /** Arm a deferred so the next rerun call blocks until resolveNext(). */
      arm() {
        let resolve!: (v: unknown) => void;
        const promise = new Promise<unknown>((r) => { resolve = r; });
        deferred = { promise, resolve };
      },
      resolveNext(v: unknown) { deferred?.resolve(v); },
      armDispatch() {
        let resolve!: (v: unknown) => void;
        const promise = new Promise<unknown>((r) => { resolve = r; });
        dispatchDeferred = { promise, resolve };
      },
      resolveDispatch(v: unknown) { dispatchDeferred?.resolve(v); },
      armSteer() {
        let resolve!: (v: unknown) => void;
        const promise = new Promise<unknown>((r) => { resolve = r; });
        steerDeferred = { promise, resolve };
      },
      resolveSteer(v: unknown) { steerDeferred?.resolve(v); },
    },
    impl: async (input: { packetId: string; feedback: string }) => {
      calls += 1;
      if (deferred) {
        await deferred.promise;
        deferred = null;
      }
      return { ok: true, packetId: input.packetId, dispatched: true, laneId: `lane-${calls}` };
    },
    dispatchImpl: async (input: { missionId?: string }) => {
      dispatchCalls += 1;
      if (dispatchDeferred) {
        await dispatchDeferred.promise;
        dispatchDeferred = null;
      }
      return { initiated: true, dispatched: 1, missionId: input.missionId ?? 'mission-active' };
    },
    steerImpl: async (input: { packetId: string; message: string; source?: string }) => {
      steerCalls += 1;
      if (steerDeferred) {
        await steerDeferred.promise;
        steerDeferred = null;
      }
      return {
        ok: true,
        packetId: input.packetId,
        laneId: `steer-lane-${steerCalls}`,
        note: input.message,
      };
    },
    resetImpl: async (input: { packetId: string; clearWorktree: boolean }) => {
      resetCalls += 1;
      return {
        reset: true,
        salvaged: false,
        packetId: input.packetId,
        referenceLabel: input.packetId,
        worktreePruned: input.clearWorktree,
        branchDeleted: false,
        note: 'reset complete',
      };
    },
  };
});

vi.mock('@/lib/orchestrator/operator-mission-service', () => ({
  dispatchMission: (input: { missionId?: string }) => h.dispatchImpl(input),
  MissionNotFoundError: class MissionNotFoundError extends Error {},
  resolveMissionDispatchTarget: (missionId?: string) => missionId ?? 'mission-active',
  rerunWithFeedback: (input: { packetId: string; feedback: string }) => h.impl(input),
  resetPacket: (input: { packetId: string; clearWorktree: boolean }) => h.resetImpl(input),
  steerPacket: (input: { packetId: string; message: string; source?: string }) => h.steerImpl(input),
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-idempotency-'));
const WS_TOKEN = 'operator-ws-token-idem-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${WS_TOKEN}\n`, 'utf-8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const rerun = await import('@/app/api/orchestrator/rerun-with-feedback/route');
const dispatch = await import('@/app/api/orchestrator/dispatch/route');
const reset = await import('@/app/api/orchestrator/reset-packet/route');
const steer = await import('@/app/api/orchestrator/steer-packet/route');
const idempotency = await import('@/lib/orchestrator/idempotency-store');
const { closeDb, getSqlite } = await import('@/lib/db');

const RERUN_URL = 'http://localhost:3001/api/orchestrator/rerun-with-feedback';
const DISPATCH_URL = 'http://localhost:3001/api/orchestrator/dispatch';
const STEER_URL = 'http://localhost:3001/api/orchestrator/steer-packet';
const RESET_URL = 'http://localhost:3001/api/orchestrator/reset-packet';

function post(body: unknown, url = RERUN_URL): NextRequest {
  return new NextRequest(url, {
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

  it('refuses a mutation without a caller-provided idempotency key', async () => {
    const response = await rerun.POST(post({ packetId: 'pkt-idem-required', feedback: 'try again' }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'idempotency_key_required' },
    });
    expect(h.state.calls).toBe(0);
  });

  it('a timeout+retry of the SAME call executes once and replays the second response', async () => {
    const body = {
      packetId: 'pkt-idem-1',
      feedback: 'typecheck failed; fix imports',
      idempotencyKey: 'rerun-timeout-retry-1',
    };

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
    const body = {
      packetId: 'pkt-idem-inflight',
      feedback: 'redo the migration',
      idempotencyKey: 'rerun-inflight-1',
    };
    h.state.arm(); // the first call will block until we resolve it

    const firstPromise = rerun.POST(post(body)); // reserves, then blocks in run()
    // Give the reserve INSERT time to land before the duplicate arrives.
    await new Promise((r) => setTimeout(r, 25));

    const duplicateResponse = await rerun.POST(post(body));
    expect(duplicateResponse.status).toBe(202);
    const dup = await json(duplicateResponse);
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
    const body = {
      packetId: 'pkt-idem-restart',
      feedback: 'address review comments',
      idempotencyKey: 'rerun-restart-1',
    };

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

  it('identical feedback with distinct invocation ids executes twice', async () => {
    const base = { packetId: 'pkt-idem-2', feedback: 'repeat this deliberate rerun' };
    const a = await json(await rerun.POST(post({ ...base, idempotencyKey: 'rerun-repeat-1' })));
    const b = await json(await rerun.POST(post({ ...base, idempotencyKey: 'rerun-repeat-2' })));
    expect((a.result as Record<string, unknown>).replayed).toBeUndefined();
    expect((b.result as Record<string, unknown>).replayed).toBeUndefined();
    expect(h.state.calls).toBe(2);
  });

  it('rejects idempotency key reuse with changed feedback', async () => {
    const first = {
      packetId: 'pkt-idem-conflict',
      feedback: 'first feedback',
      idempotencyKey: 'rerun-conflict-1',
    };

    expect((await rerun.POST(post(first))).status).toBe(200);
    const conflict = await rerun.POST(post({ ...first, feedback: 'changed feedback' }));

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: 'idempotency_key_conflict' },
    });
    expect(h.state.calls).toBe(1);
  });

  it('fails closed when the persisted mutation binding is unavailable', async () => {
    const bind = vi.spyOn(idempotency, 'bindIdempotencyClientMutation').mockReturnValueOnce({
      status: 'unavailable',
      digest: 'unavailable',
    });
    try {
      const response = await rerun.POST(post({
        packetId: 'pkt-idem-unavailable',
        feedback: 'do not run',
        idempotencyKey: 'rerun-unavailable-1',
      }));

      expect(response.status).toBe(503);
      expect(h.state.calls).toBe(0);
    } finally {
      bind.mockRestore();
    }
  });
});

describe('persisted idempotency — waited dispatch through the real route', () => {
  beforeEach(() => h.state.reset());

  it('returns 202 for an in-flight duplicate without dispatching twice', async () => {
    const body = {
      missionId: 'mission-idem-waited',
      wait: true,
      idempotencyKey: 'dispatch-waited-inflight-1',
    };
    h.state.armDispatch();

    const firstPromise = dispatch.POST(post(body, DISPATCH_URL));
    await new Promise((resolve) => setTimeout(resolve, 25));

    const duplicateResponse = await dispatch.POST(post(body, DISPATCH_URL));
    expect(duplicateResponse.status).toBe(202);
    await expect(duplicateResponse.json()).resolves.toMatchObject({
      ok: true,
      result: { replayed: true, inProgress: true, status: 'in_progress' },
    });
    expect(h.state.dispatchCalls).toBe(1);

    h.state.resolveDispatch(undefined);
    expect((await firstPromise).status).toBe(200);
    expect(h.state.dispatchCalls).toBe(1);
  });
});

describe('persisted idempotency — reset and retry through the real route', () => {
  beforeEach(() => h.state.reset());

  it('rejects one mutation id reused across retry and destructive reset intent', async () => {
    const first = {
      packetId: 'pkt-reset-conflict',
      clearWorktree: false,
      idempotencyKey: 'reset-conflict-1',
    };
    expect((await reset.POST(post(first, RESET_URL))).status).toBe(200);

    const conflict = await reset.POST(post({ ...first, clearWorktree: true }, RESET_URL));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'idempotency_key_conflict' },
    });
    expect(h.state.resetCalls).toBe(1);
  });
});

describe('persisted idempotency — steer_packet through the real route', () => {
  beforeEach(() => h.state.reset());

  it('refuses a mutation without a caller-provided idempotency key', async () => {
    const response = await steer.POST(post({ packetId: 'pkt-steer-required', message: 'continue' }, STEER_URL));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'idempotency_key_required' },
    });
    expect(h.state.steerCalls).toBe(0);
  });

  it('retries with the same invocation id replay once', async () => {
    const body = {
      packetId: 'pkt-steer-replay',
      message: 'continue with the focused test',
      idempotencyKey: 'steer-replay-1',
    };

    const first = await json(await steer.POST(post(body, STEER_URL)));
    const replay = await json(await steer.POST(post(body, STEER_URL)));

    expect((first.result as Record<string, unknown>).replayed).toBeUndefined();
    expect(replay.result).toMatchObject({ replayed: true, laneId: 'steer-lane-1' });
    expect(h.state.steerCalls).toBe(1);
  });

  it('returns 202 for an in-flight duplicate without steering twice', async () => {
    const body = {
      packetId: 'pkt-steer-inflight',
      message: 'continue once',
      idempotencyKey: 'steer-inflight-1',
    };
    h.state.armSteer();

    const firstPromise = steer.POST(post(body, STEER_URL));
    await new Promise((resolve) => setTimeout(resolve, 25));

    const duplicateResponse = await steer.POST(post(body, STEER_URL));
    expect(duplicateResponse.status).toBe(202);
    await expect(duplicateResponse.json()).resolves.toMatchObject({
      ok: true,
      result: { replayed: true, inProgress: true, status: 'in_progress' },
    });
    expect(h.state.steerCalls).toBe(1);

    h.state.resolveSteer(undefined);
    expect((await firstPromise).status).toBe(200);
    expect(h.state.steerCalls).toBe(1);
  });

  it('identical messages with distinct invocation ids execute twice', async () => {
    const base = { packetId: 'pkt-steer-repeat', message: 'continue with the focused test' };

    const first = await json(await steer.POST(post({ ...base, idempotencyKey: 'steer-repeat-1' }, STEER_URL)));
    const second = await json(await steer.POST(post({ ...base, idempotencyKey: 'steer-repeat-2' }, STEER_URL)));

    expect((first.result as Record<string, unknown>).replayed).toBeUndefined();
    expect((second.result as Record<string, unknown>).replayed).toBeUndefined();
    expect(h.state.steerCalls).toBe(2);
  });

  it('rejects idempotency key reuse with a changed message', async () => {
    const first = {
      packetId: 'pkt-steer-conflict',
      message: 'first message',
      idempotencyKey: 'steer-conflict-1',
    };

    expect((await steer.POST(post(first, STEER_URL))).status).toBe(200);
    const conflict = await steer.POST(post({ ...first, message: 'changed message' }, STEER_URL));

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: 'idempotency_key_conflict' },
    });
    expect(h.state.steerCalls).toBe(1);
  });
});

describe('persisted idempotency store finalization safety', () => {
  it('attaches a same-process duplicate to the owning terminal result', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let executions = 0;
    const params = {
      key: 'attached-in-flight:test',
      verb: 'attached_in_flight_test',
      scopeId: 'attached-in-flight',
      attachToInFlight: true,
    };

    const firstPromise = idempotency.withIdempotency(params, async () => {
      executions += 1;
      await blocked;
      return { ok: true, receipt: 'one-result' };
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const duplicatePromise = idempotency.withIdempotency(params, async () => {
      executions += 1;
      return { ok: false, receipt: 'duplicate-execution' };
    });

    release();
    const [first, duplicate] = await Promise.all([firstPromise, duplicatePromise]);
    expect(first).toMatchObject({ replayed: false, inProgress: false });
    expect(duplicate).toEqual({ ...first, replayed: true, inProgress: false });
    expect(executions).toBe(1);
  });

  it('preserves an in-progress result when local callers attach to a persisted owner', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let executions = 0;
    const params = {
      key: 'attached-persisted-owner:test',
      verb: 'attached_persisted_owner_test',
      scopeId: 'attached-persisted-owner',
    };
    const owner = idempotency.withIdempotency(params, async () => {
      executions += 1;
      await blocked;
      return { ok: true };
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const firstDuplicate = idempotency.withIdempotency({ ...params, attachToInFlight: true }, async () => {
      executions += 1;
      return { ok: false };
    });
    const attachedDuplicate = idempotency.withIdempotency({ ...params, attachToInFlight: true }, async () => {
      executions += 1;
      return { ok: false };
    });
    try {
      const [first, attached] = await Promise.all([firstDuplicate, attachedDuplicate]);
      expect(first).toMatchObject({ replayed: true, inProgress: true });
      expect(attached).toMatchObject({ replayed: true, inProgress: true });
      expect(executions).toBe(1);
    } finally {
      release();
      await owner;
    }
  });

  it('preserves a live reservation past its TTL so a second execution cannot reserve', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let executions = 0;
    const params = {
      key: 'live-reservation-past-ttl:test',
      verb: 'live_reservation_test',
      scopeId: 'live-reservation-test',
      ttlMs: 100,
    };

    const firstPromise = idempotency.withIdempotency({ ...params, now: 1_000 }, async () => {
      executions += 1;
      await blocked;
      return { ok: true };
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const duplicate = await idempotency.withIdempotency({ ...params, now: 1_101 }, async () => {
      executions += 1;
      return { ok: true };
    });

    expect(duplicate).toMatchObject({
      replayed: true,
      inProgress: true,
      result: { status: 'in_progress' },
    });
    expect(executions).toBe(1);

    release();
    await firstPromise;
  });

  it('does not finalize or cache a result after reservation ownership changes', async () => {
    const key = 'finalization-owner-loss:test';
    const outcome = await idempotency.withIdempotency(
      { key, verb: 'owner_loss_test', scopeId: 'owner-loss' },
      async () => {
        getSqlite().prepare(
          'UPDATE idempotency_keys SET reservation_id = ? WHERE key = ? AND result_json IS NULL',
        ).run('replacement-reservation', key);
        return { ok: true };
      },
    );

    expect(outcome).toMatchObject({ persistenceDegraded: true, result: { ok: true } });
    const persisted = getSqlite().prepare(
      'SELECT result_json, reservation_id FROM idempotency_keys WHERE key = ?',
    ).get(key) as { result_json: string | null; reservation_id: string };
    expect(persisted).toEqual({ result_json: null, reservation_id: 'replacement-reservation' });

    const duplicate = await idempotency.withIdempotency(
      { key, verb: 'owner_loss_test', scopeId: 'owner-loss' },
      async () => ({ ok: false }),
    );
    expect(duplicate).toMatchObject({ replayed: true, inProgress: true });
  });

  it('returns and replays the successful receipt when finalization fails after the side effect', async () => {
    const sqlite = getSqlite();
    const originalPrepare = sqlite.prepare.bind(sqlite);
    const prepare = vi.spyOn(sqlite, 'prepare').mockImplementation(((sql: string) => {
      if (sql.startsWith('UPDATE idempotency_keys SET result_json')) {
        throw new Error('finalization write failed');
      }
      return originalPrepare(sql);
    }) as typeof sqlite.prepare);
    let executions = 0;
    const params = {
      key: 'finalization-failure:test',
      verb: 'finalization_failure_test',
      scopeId: 'finalization-failure',
    };

    let first;
    try {
      first = await idempotency.withIdempotency(params, async () => {
        executions += 1;
        return { ok: true };
      });
    } finally {
      prepare.mockRestore();
    }

    const retry = await idempotency.withIdempotency(params, async () => {
      executions += 1;
      return { ok: true };
    });
    expect(first).toMatchObject({ persistenceDegraded: true, result: { ok: true } });
    expect(retry).toMatchObject({ replayed: true, persistenceDegraded: true, result: { ok: true } });
    expect(executions).toBe(1);
  });
});
