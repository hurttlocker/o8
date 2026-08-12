/**
 * Merge idempotency + reservation-reaper (#1513), driven through the REAL
 * approve-and-merge route (`/api/orchestrator/merge`). The merge verb was
 * migrated off the in-memory `idempotency-cache.ts` (deleted) onto the persisted
 * reserve→finalize store. The in-memory cache deliberately forgot in-flight
 * merges on restart so the operator could retry immediately; the persisted store
 * must NOT regress that. It stamps the owning pid on each reservation and, on DB
 * init, quarantines reservations whose owner is dead — so:
 *
 *   1. a LIVE in-flight duplicate is still deduped (no double merge), but
 *   2. a restart-interrupted merge (reserving process died) remains guarded and
 *      reports an unknown outcome instead of risking a second merge.
 *
 * We do NOT unit-test the store in isolation — we POST the real route, hold a
 * call "in flight" via a deferred, and simulate a restart by tampering the row's
 * pid to a guaranteed-dead value + closeDb() (the route re-opens the same file).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => {
  let calls = 0;
  // The FIRST impl call after arm() blocks on `armedPromise` (claiming it so a
  // later call runs freely — the restart-retry must not block on the abandoned
  // original). `resolve` holds the resolver so the test can drain the original.
  let armedPromise: Promise<unknown> | null = null;
  let resolve: ((v: unknown) => void) | null = null;
  return {
    state: {
      get calls() { return calls; },
      reset() { calls = 0; armedPromise = null; resolve = null; },
      arm() {
        armedPromise = new Promise<unknown>((r) => { resolve = r; });
      },
      resolveNext(v: unknown) { resolve?.(v); resolve = null; },
    },
    impl: async (input: { packetId: string }) => {
      const run = ++calls;
      const blockOn = armedPromise;
      armedPromise = null; // claim — the next impl call won't block on it
      if (blockOn) await blockOn;
      return { ok: true, merged: true, packetId: input.packetId, run };
    },
  };
});

// Mock the merge module: approveAndMergePacket → counter+deferred; never a head
// mismatch. loadMergeModule is called twice per POST (try + catch), so return a
// stable object.
vi.mock('@/lib/orchestrator/operator-mission-service/merge-warmup', () => ({
  loadMergeModule: async () => ({
    approveAndMergePacket: (input: { packetId: string }) => h.impl(input),
    isHeadShaMismatchError: () => false,
  }),
}));

// Passthrough the worktree-cleanup wrapper — its real behavior (git status) is
// irrelevant to the idempotency seam under test.
vi.mock('@/lib/orchestrator/worktree-cleanup', () => ({
  withSynchronousWorktreeCleanup: <T>(_packetId: string, fn: () => Promise<T>) => fn(),
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-idem-merge-'));
const WS_TOKEN = 'operator-ws-token-merge-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${WS_TOKEN}\n`, 'utf-8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const merge = await import('@/app/api/orchestrator/merge/route');
const { closeDb, getSqlite } = await import('@/lib/db');
const { archiveLane, createLane, updateLane } = await import('@/lib/lane/registry');

const URL = 'http://localhost:3001/api/orchestrator/merge';

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

describe('merge idempotency + reservation-reaper — through the real merge route', () => {
  beforeEach(() => h.state.reset());

  it('requires per-invocation correlation before entering the merge gate', async () => {
    const response = await merge.POST(post({ packetId: 'pkt-merge-no-key' }));
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: 'idempotency_key_required' },
    });
    expect(h.state.calls).toBe(0);
  });

  it('refuses reuse of a correlation key with changed merge intent', async () => {
    const first = await merge.POST(post({
      packetId: 'pkt-merge-bound',
      commitMessage: 'first message',
      idempotencyKey: 'merge-bound-key',
    }));
    expect(first.status).toBe(200);

    const conflict = await merge.POST(post({
      packetId: 'pkt-merge-bound',
      commitMessage: 'different message',
      idempotencyKey: 'merge-bound-key',
    }));
    expect(conflict.status).toBe(409);
    expect(await json(conflict)).toMatchObject({
      ok: false,
      error: { code: 'idempotency_key_conflict' },
    });
    expect(h.state.calls).toBe(1);
  });

  it('a LIVE in-flight duplicate is deduped (no second merge)', async () => {
    const body = { packetId: 'pkt-merge-live', commitMessage: 'ship it', idempotencyKey: 'merge-live' };
    h.state.arm();

    const firstPromise = merge.POST(post(body)); // reserves (pid=this proc), blocks
    await new Promise((r) => setTimeout(r, 25));

    const duplicateResponse = await merge.POST(post(body));
    expect(duplicateResponse.status).toBe(202);
    const dup = await json(duplicateResponse);
    expect((dup.result as Record<string, unknown>).replayed).toBe(true);
    expect((dup.result as Record<string, unknown>).inProgress).toBe(true);
    expect((dup.result as Record<string, unknown>).status).toBe('in_progress');
    expect(h.state.calls).toBe(1); // the duplicate did NOT merge

    h.state.resolveNext(undefined);
    const first = await json(await firstPromise);
    expect((first.result as Record<string, unknown>).merged).toBe(true);
    expect(h.state.calls).toBe(1);
  });

  it('holds a restart-interrupted merge with an unknown outcome', async () => {
    const body = { packetId: 'pkt-merge-restart', commitMessage: 'address review', idempotencyKey: 'merge-restart' };
    h.state.arm();

    const firstPromise = merge.POST(post(body)); // reserves (pid=this proc), blocks
    await new Promise((r) => setTimeout(r, 25));

    // Simulate the owning process crashing mid-merge: point the reservation at a
    // guaranteed-dead pid, then drop the DB singleton (== process restart). The
    // next route call re-opens the SAME file and init-time recovery should
    // quarantine, rather than delete, the orphaned reservation.
    const deadPid = 2_147_483_600; // absurdly high — never a live pid
    getSqlite()
      .prepare('UPDATE idempotency_keys SET pid = ? WHERE result_json IS NULL')
      .run(deadPid);
    closeDb();

    const afterRestartResponse = await merge.POST(post(body));
    const afterRestart = await json(afterRestartResponse);
    expect(afterRestartResponse.status).toBe(409);
    expect(afterRestart).toMatchObject({
      ok: false,
      error: {
        code: 'outcome_unknown',
        message: expect.stringContaining('remains quarantined'),
      },
    });
    expect(h.state.calls).toBe(1);

    // Drain the original (now-orphaned) call so no promise dangles.
    h.state.resolveNext(undefined);
    await firstPromise.catch(() => undefined);
  });

  it('archiving the packet preserves its live reservation until the owner finalizes', async () => {
    const packetId = 'pkt-merge-archived-terminal';
    const body = { packetId, commitMessage: 'retry after terminal cleanup', idempotencyKey: 'merge-terminal' };
    const lane = createLane({
      repoPath: dataDir,
      branch: 'inline/idempotency-terminal',
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
    });
    updateLane(lane.id, { outcome: 'discarded', outcomeNote: 'test terminal operation' });
    h.state.arm();

    const firstPromise = merge.POST(post(body));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(archiveLane(lane.id, 'system')?.status).toBe('archived');

    const duplicate = await json(await merge.POST(post(body)));
    expect((duplicate.result as Record<string, unknown>).inProgress).toBe(true);
    expect(h.state.calls).toBe(1);

    h.state.resolveNext(undefined);
    await firstPromise;
    const replay = await json(await merge.POST(post(body)));
    expect((replay.result as Record<string, unknown>).run).toBe(1);
    expect((replay.result as Record<string, unknown>).replayed).toBe(true);
  });
});
