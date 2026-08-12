import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  AgentRuntime,
  RuntimeSession,
  RuntimeSessionTransformInput,
  RuntimeSessionTransformProviderResult,
} from '@/lib/runtimes/types';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-session-transform-real-path-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const rootSession: RuntimeSession = {
  sessionKey: 'opencode:fixture-root',
  runtimeId: 'opencode',
  displayName: 'Fixture root',
  cwd: dataDir,
  status: 'idle',
  ownership: 'discovered',
  sessionCapabilities: { canSendInput: true, canInterrupt: false, canReviewDiffs: true },
  lastActivityAt: new Date(),
};

const sessions = new Map<string, RuntimeSession>([[rootSession.sessionKey, rootSession]]);
const resumed: Array<{ sessionKey: string; message: string }> = [];
const recoveryForks = new Map<string, RuntimeSession>();
let forkCount = 0;
let checkpointCalls = 0;
let failNextCheckpoint = false;
let failNextForkAmbiguously = false;
let holdNextCheckpoint: Promise<void> | null = null;
let mutateHeadOnNextFork: (() => void) | null = null;

const fixtureRuntime: AgentRuntime = {
  id: 'opencode',
  displayName: 'Fixture session runtime',
  capabilities: {
    discover: true,
    readTranscript: true,
    launch: false,
    resume: true,
    interrupt: false,
    reviewDiffs: false,
    costTelemetry: false,
    streaming: false,
    sessionTransforms: { import: true, checkpoint: true, fork: true, rewind: true },
  },
  async discoverSessions() { return [...sessions.values()]; },
  async readTranscript() { return []; },
  async launch() { return { ok: false, note: 'unsupported' }; },
  async resume(sessionKey, message) {
    resumed.push({ sessionKey, message });
    return { ok: true, note: 'Fixture resumed.', sessionKey };
  },
  async interrupt() { return { ok: false, note: 'unsupported' }; },
  async getChangedFiles() { return []; },
  getSessionTransformCapabilities() {
    return {
      import: { supported: true },
      checkpoint: { supported: true },
      fork: { supported: true },
      rewind: { supported: true },
    };
  },
  async transformSession(input: RuntimeSessionTransformInput): Promise<RuntimeSessionTransformProviderResult> {
    const originalSession = sessions.get(input.sessionKey) ?? rootSession;
    if (input.action === 'import') {
      return { ok: true, note: 'imported', originalSession, resultingSession: originalSession };
    }
    if (input.action === 'checkpoint') {
      checkpointCalls += 1;
      if (holdNextCheckpoint) await holdNextCheckpoint;
      if (failNextCheckpoint) {
        failNextCheckpoint = false;
        return { ok: false, note: 'provider refused checkpoint', reason: 'provider_error', originalSession };
      }
      return {
        ok: true,
        note: 'checkpointed',
        originalSession,
        resultingSession: originalSession,
        providerCheckpointRef: 'fixture-turn-1',
      };
    }
    if (input.providerCheckpointRef !== 'fixture-turn-1') {
      return {
        ok: false,
        note: 'stale checkpoint',
        reason: 'stale_checkpoint',
        sideEffect: 'none',
        originalSession,
      };
    }
    if (failNextForkAmbiguously) {
      failNextForkAmbiguously = false;
      return {
        ok: false,
        note: 'provider connection closed before the fork response',
        reason: 'provider_error',
        retryable: true,
        sideEffect: 'unknown',
        originalSession,
      };
    }
    mutateHeadOnNextFork?.();
    mutateHeadOnNextFork = null;
    forkCount += 1;
    const resultingSession: RuntimeSession = {
      ...originalSession,
      sessionKey: `opencode:fixture-fork-${forkCount}`,
      displayName: `Fixture fork ${forkCount}`,
      ownership: 'provider',
    };
    sessions.set(resultingSession.sessionKey, resultingSession);
    recoveryForks.set(input.sessionKey, resultingSession);
    return {
      ok: true,
      note: input.action === 'rewind' ? 'rewound immutably' : 'forked',
      originalSession,
      resultingSession,
      providerCheckpointRef: input.providerCheckpointRef,
      providerSessionCreated: true,
    };
  },
  async recoverSessionTransform(input) {
    const originalSession = sessions.get(input.sessionKey);
    const resultingSession = recoveryForks.get(input.sessionKey);
    if (!originalSession || !resultingSession || input.providerCheckpointRef !== 'fixture-turn-1') return null;
    return {
      ok: true,
      note: 'fixture continuation recovered',
      originalSession,
      resultingSession,
      providerCheckpointRef: input.providerCheckpointRef,
      providerSessionCreated: true,
    };
  },
};

let transformRoute: typeof import('@/app/api/runtime/session-transform/route');
let actionRoute: typeof import('@/app/api/runtime/action/route');
let mutationCounter = 0;

function transformRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/runtime/session-transform', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postTransform(body: Record<string, unknown>) {
  mutationCounter += 1;
  return transformRoute.POST(transformRequest({
    clientMutationId: `session-transform-test-${mutationCounter}`,
    ...body,
  }) as never);
}

beforeAll(async () => {
  transformRoute = await import('@/app/api/runtime/session-transform/route');
  actionRoute = await import('@/app/api/runtime/action/route');
  const { registerRuntime } = await import('@/lib/runtimes/registry');
  registerRuntime(fixtureRuntime);
  const { __resetIdempotencyStoreForTests } = await import('@/lib/orchestrator/idempotency-store');
  __resetIdempotencyStoreForTests();
});

afterAll(() => {
  delete process.env.CORTEX_IDE_DATA_DIR;
  delete process.env.O8_DATA_DIR;
});

describe('session transform production route', () => {
  it('proves import -> checkpoint -> fork -> resume without packet ownership', async () => {
    const imported = await postTransform({
      action: 'import',
      runtimeId: 'opencode',
      sessionKey: rootSession.sessionKey,
      expectedCatalogVersion: 0,
      clientMutationId: 'session-transform-root-import',
    });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({
      action: 'import', catalogVersion: 1, resultingSessionKey: rootSession.sessionKey,
    });

    const checkpointed = await postTransform({
      action: 'checkpoint', runtimeId: 'opencode', sessionKey: rootSession.sessionKey, expectedCatalogVersion: 1,
    });
    const checkpointBody = await checkpointed.json() as { checkpointId: string };
    expect(checkpointed.status).toBe(200);
    expect(checkpointBody.checkpointId).toMatch(/^checkpoint-/);

    const forked = await postTransform({
      action: 'fork',
      runtimeId: 'opencode',
      sessionKey: rootSession.sessionKey,
      checkpointId: checkpointBody.checkpointId,
      expectedCatalogVersion: 2,
    });
    const forkBody = await forked.json() as { resultingSessionKey: string };
    expect(forked.status).toBe(200);
    expect(forkBody.resultingSessionKey).toBe('opencode:fixture-fork-1');

    const rewound = await postTransform({
      action: 'rewind',
      runtimeId: 'opencode',
      sessionKey: rootSession.sessionKey,
      checkpointId: checkpointBody.checkpointId,
      expectedCatalogVersion: 3,
    });
    expect(rewound.status).toBe(200);
    expect(await rewound.json()).toMatchObject({
      resultingSessionKey: 'opencode:fixture-fork-2',
      catalogVersion: 4,
    });
    expect(sessions.has(rootSession.sessionKey)).toBe(true);

    const resumedResponse = await actionRoute.POST(new Request('http://localhost/api/runtime/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'send_input',
        surfaceId: forkBody.resultingSessionKey,
        clientMutationId: 'session-transform-resume-fixture',
        message: 'continue from the fork',
      }),
    }) as never);
    expect(resumedResponse.status).toBe(200);
    expect(resumed).toContainEqual({
      sessionKey: forkBody.resultingSessionKey,
      message: 'continue from the fork',
    });

    // Catalog adoption remains actionable even after ordinary runtime
    // discovery stops returning the provider session.
    sessions.delete(forkBody.resultingSessionKey);
    const { invalidateRuntimeInventoryCache } = await import('@/lib/runtime/inventory');
    invalidateRuntimeInventoryCache();
    const persistedResume = await actionRoute.POST(new Request('http://localhost/api/runtime/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'send_input',
        surfaceId: forkBody.resultingSessionKey,
        clientMutationId: 'session-transform-resume-persisted-fixture',
        message: 'resume the cataloged session',
      }),
    }) as never);
    expect(persistedResume.status).toBe(200);
    expect(resumed).toContainEqual({
      sessionKey: forkBody.resultingSessionKey,
      message: 'resume the cataloged session',
    });

    const { findLaneBySession } = await import('@/lib/lane/registry');
    expect(findLaneBySession(forkBody.resultingSessionKey)).toBeNull();
    const catalog = JSON.parse(readFileSync(path.join(dataDir, 'session-transform-catalog.json'), 'utf8')) as {
      sessions: Array<{ sessionKey: string; ownership: string; lineage: unknown }>;
    };
    expect(catalog.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionKey: rootSession.sessionKey,
        ownership: 'discovered',
        lineage: null,
      }),
      expect.objectContaining({
        sessionKey: forkBody.resultingSessionKey,
        ownership: 'provider',
        lineage: expect.objectContaining({ parentSessionKey: rootSession.sessionKey }),
      }),
      expect.objectContaining({
        sessionKey: 'opencode:fixture-fork-2',
        lineage: expect.objectContaining({ action: 'rewind', parentSessionKey: rootSession.sessionKey }),
      }),
    ]));
    expect(statSync(path.join(dataDir, 'session-transform-catalog.json')).mode & 0o777).toBe(0o600);
  });

  it('serializes same-version transforms so only one commits', async () => {
    const beforeCalls = checkpointCalls;
    const [first, second] = await Promise.all([
      postTransform({
        action: 'checkpoint', runtimeId: 'opencode', sessionKey: rootSession.sessionKey, expectedCatalogVersion: 4,
      }),
      postTransform({
        action: 'checkpoint', runtimeId: 'opencode', sessionKey: rootSession.sessionKey, expectedCatalogVersion: 4,
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(checkpointCalls - beforeCalls).toBe(1);
  });

  it('keeps catalog bytes and version unchanged after provider failure or stale checkpoint', async () => {
    const catalogPath = path.join(dataDir, 'session-transform-catalog.json');
    const before = readFileSync(catalogPath);
    failNextCheckpoint = true;
    const providerFailure = await postTransform({
      action: 'checkpoint', runtimeId: 'opencode', sessionKey: rootSession.sessionKey, expectedCatalogVersion: 5,
    });
    expect(providerFailure.status).toBe(502);
    expect(readFileSync(catalogPath)).toEqual(before);

    const staleCheckpoint = await postTransform({
      action: 'fork',
      runtimeId: 'opencode',
      sessionKey: rootSession.sessionKey,
      checkpointId: 'checkpoint-does-not-exist',
      expectedCatalogVersion: 5,
    });
    expect(staleCheckpoint.status).toBe(404);
    expect(readFileSync(catalogPath)).toEqual(before);
  });

  it('records before/after HEAD and invalidates bound review approval after code drift', async () => {
    const repo = path.join(dataDir, 'code-bearing-repo');
    execFileSync('git', ['init', '-b', 'main', repo]);
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repo });
    writeFileSync(path.join(repo, 'README.md'), 'before\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });
    const beforeHeadSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const codeSession: RuntimeSession = {
      ...rootSession,
      sessionKey: 'opencode:fixture-code-root',
      displayName: 'Fixture code root',
      cwd: repo,
      headSha: beforeHeadSha,
    };
    sessions.set(codeSession.sessionKey, codeSession);

    const imported = await postTransform({
      action: 'import', runtimeId: 'opencode', sessionKey: codeSession.sessionKey, expectedCatalogVersion: 5,
    });
    expect(imported.status).toBe(200);
    const checkpointed = await postTransform({
      action: 'checkpoint', runtimeId: 'opencode', sessionKey: codeSession.sessionKey, expectedCatalogVersion: 6,
    });
    const checkpoint = await checkpointed.json() as { checkpointId: string };

    const { createLane, getLane } = await import('@/lib/lane/registry');
    const lane = createLane({
      repoPath: repo,
      worktreePath: repo,
      branch: 'main',
      runtime: 'opencode',
      sessionKey: codeSession.sessionKey,
      packetId: 'pkt-session-transform-governance',
      ownership: 'attached',
    });
    const {
      createApproval,
      recordOrchestratorReview,
      listApprovalsForContext,
    } = await import('@/lib/approvals/store');
    recordOrchestratorReview('pkt-session-transform-governance', {
      approved: true,
      findings: [],
      reviewedHeadSha: beforeHeadSha,
      reviewer: 'test',
    });
    const pendingMerge = createApproval({
      source: 'test',
      runtime: 'opencode',
      agent: 'fixture',
      sessionKey: codeSession.sessionKey,
      title: 'Merge fixture continuation',
      description: 'Approval bound to the reviewed HEAD.',
      summary: 'Merge after review',
      risk: 'medium',
      metadata: { Packet: 'pkt-session-transform-governance', Lane: lane.id },
      continuation: {
        kind: 'lane',
        laneId: lane.id,
        verb: 'merge',
        expectedHeadSha: beforeHeadSha,
      },
    });
    expect(pendingMerge.status).toBe('pending');
    expect(listApprovalsForContext({ packetId: 'pkt-session-transform-governance' }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ status: 'approved' })]));

    mutateHeadOnNextFork = () => {
      writeFileSync(path.join(repo, 'README.md'), 'after\n');
      execFileSync('git', ['add', 'README.md'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'provider continuation'], { cwd: repo });
    };
    const transformed = await postTransform({
      action: 'fork',
      runtimeId: 'opencode',
      sessionKey: codeSession.sessionKey,
      checkpointId: checkpoint.checkpointId,
      expectedCatalogVersion: 7,
    });
    expect(transformed.status).toBe(200);
    const result = await transformed.json() as {
      beforeHeadSha: string;
      afterHeadSha: string;
      staleGovernanceInvalidated: boolean;
    };
    expect(result.beforeHeadSha).toBe(beforeHeadSha);
    expect(result.afterHeadSha).not.toBe(beforeHeadSha);
    expect(result.staleGovernanceInvalidated).toBe(true);
    expect(getLane(lane.id)?.status).toBe('reviewing');
    expect(listApprovalsForContext({ packetId: 'pkt-session-transform-governance' }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ args: expect.objectContaining({ reviewSuperseded: true }) }),
        expect.objectContaining({ id: pendingMerge.id, status: 'rejected' }),
      ]));
    const catalog = JSON.parse(readFileSync(path.join(dataDir, 'session-transform-catalog.json'), 'utf8')) as {
      receipts: Array<Record<string, unknown>>;
    };
    expect(catalog.receipts.at(-1)).toMatchObject({
      action: 'fork',
      beforeHeadSha,
      afterHeadSha: result.afterHeadSha,
      staleGovernanceInvalidated: true,
      packetId: 'pkt-session-transform-governance',
      laneId: lane.id,
    });
  });

  it('reconciles a provider fork after a crash before the catalog commit', async () => {
    const providerResult = await fixtureRuntime.transformSession!({
      action: 'fork',
      sessionKey: rootSession.sessionKey,
      providerCheckpointRef: 'fixture-turn-1',
    });
    expect(providerResult.ok).toBe(true);
    const { writeSessionTransformIntents, readSessionTransformIntents } = await import(
      '@/lib/runtime/session-transform-catalog'
    );
    await writeSessionTransformIntents([{
      id: 'transform-recovery-fixture',
      clientMutationId: 'session-transform-crash-retry',
      action: 'fork',
      runtimeId: 'opencode',
      originalSessionKey: rootSession.sessionKey,
      checkpointId: 'checkpoint-recovery-fixture',
      providerCheckpointRef: 'fixture-turn-1',
      expectedCatalogVersion: 8,
      phase: 'provider_started',
      startedAt: new Date().toISOString(),
      beforeHeadSha: null,
      codeCwd: null,
      laneId: null,
      packetId: null,
      result: null,
    }]);

    const { getSqlite } = await import('@/lib/db');
    const { deriveIdempotencyKey } = await import('@/lib/orchestrator/idempotency-store');
    const clientMutationId = 'session-transform-crash-retry';
    const scopeId = `opencode:${rootSession.sessionKey}`;
    const body = JSON.stringify({
      action: 'fork',
      runtimeId: 'opencode',
      sessionKey: rootSession.sessionKey,
      checkpointId: 'checkpoint-recovery-fixture',
      expectedCatalogVersion: 8,
    });
    const idempotencyKey = deriveIdempotencyKey({
      verb: 'runtime_session_transform.fork',
      scopeId,
      clientKey: clientMutationId,
      body,
    });
    const now = Date.now();
    getSqlite().prepare(`
      INSERT INTO idempotency_keys
        (key, verb, packet_id, result_json, pid, reservation_id, created_at, expires_at)
      VALUES (?, 'runtime_session_transform.fork', ?, NULL, NULL, 'dead-transform-reservation', ?, ?)
    `).run(idempotencyKey, scopeId, now, now + 600_000);
    const retriedAfterCrash = await transformRoute.POST(transformRequest({
      action: 'fork',
      runtimeId: 'opencode',
      sessionKey: rootSession.sessionKey,
      checkpointId: 'checkpoint-recovery-fixture',
      expectedCatalogVersion: 8,
      clientMutationId,
    }) as never);
    expect(retriedAfterCrash.status).toBe(200);
    expect(await retriedAfterCrash.json()).toMatchObject({
      resultingSessionKey: providerResult.resultingSession?.sessionKey,
      catalogVersion: 9,
      clientMutationId: 'session-transform-crash-retry',
      replayed: true,
      recovered: true,
    });
    expect(retriedAfterCrash.headers.get('x-o8-idempotency-replayed')).toBe('1');
    expect(await readSessionTransformIntents()).toEqual([]);
    const catalog = JSON.parse(readFileSync(path.join(dataDir, 'session-transform-catalog.json'), 'utf8')) as {
      sessions: Array<{ sessionKey: string; lineage: unknown }>;
      receipts: Array<{ id: string; resultingSessionKey: string }>;
    };
    expect(catalog.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionKey: providerResult.resultingSession?.sessionKey,
        lineage: expect.objectContaining({ parentSessionKey: rootSession.sessionKey }),
      }),
    ]));
    expect(catalog.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'transform-recovery-fixture',
        resultingSessionKey: providerResult.resultingSession?.sessionKey,
      }),
    ]));
  });

  it('clears a prepared crash intent because the provider call was never entered', async () => {
    const catalogPath = path.join(dataDir, 'session-transform-catalog.json');
    const before = readFileSync(catalogPath);
    const { writeSessionTransformIntents, readSessionTransformIntents } = await import(
      '@/lib/runtime/session-transform-catalog'
    );
    await writeSessionTransformIntents([{
      id: 'transform-prepared-crash',
      action: 'fork',
      runtimeId: 'opencode',
      originalSessionKey: rootSession.sessionKey,
      checkpointId: 'checkpoint-prepared-crash',
      providerCheckpointRef: 'fixture-turn-1',
      expectedCatalogVersion: 9,
      phase: 'prepared',
      startedAt: new Date().toISOString(),
      beforeHeadSha: null,
      codeCwd: null,
      laneId: null,
      packetId: null,
      result: null,
    }]);
    const response = await transformRoute.GET(new NextRequest(
      `http://localhost/api/runtime/session-transform?runtimeId=opencode&sessionKey=${encodeURIComponent(rootSession.sessionKey)}`,
    ));
    expect(response.status).toBe(200);
    expect(await readSessionTransformIntents()).toEqual([]);
    expect(readFileSync(catalogPath)).toEqual(before);
  });

  it('holds an unknowable provider-started crash for explicit operator resolution', async () => {
    const unresolvedSessionKey = 'opencode:fixture-unresolved-provider-start';
    const catalogPath = path.join(dataDir, 'session-transform-catalog.json');
    const before = readFileSync(catalogPath);
    const { writeSessionTransformIntents, readSessionTransformIntents } = await import(
      '@/lib/runtime/session-transform-catalog'
    );
    await writeSessionTransformIntents([{
      id: 'transform-provider-started-crash',
      action: 'rewind',
      runtimeId: 'opencode',
      originalSessionKey: unresolvedSessionKey,
      checkpointId: 'checkpoint-provider-started-crash',
      providerCheckpointRef: 'fixture-turn-unknown',
      expectedCatalogVersion: 9,
      phase: 'provider_started',
      startedAt: new Date().toISOString(),
      beforeHeadSha: null,
      codeCwd: null,
      laneId: null,
      packetId: null,
      result: null,
    }]);
    const stateResponse = await transformRoute.GET(new NextRequest(
      `http://localhost/api/runtime/session-transform?runtimeId=opencode&sessionKey=${encodeURIComponent(unresolvedSessionKey)}`,
    ));
    expect(await stateResponse.json()).toMatchObject({
      catalogVersion: 9,
      pendingTransform: {
        id: 'transform-provider-started-crash',
        phase: 'provider_started',
        manualResolutionRequired: true,
      },
    });
    expect(readFileSync(catalogPath)).toEqual(before);
    expect(await readSessionTransformIntents()).toHaveLength(1);

    const dismissed = await postTransform({
      action: 'dismiss_pending',
      runtimeId: 'opencode',
      sessionKey: unresolvedSessionKey,
      intentId: 'transform-provider-started-crash',
      providerOutcome: 'no_continuation',
      expectedCatalogVersion: 9,
    });
    expect(dismissed.status).toBe(200);
    expect(await readSessionTransformIntents()).toEqual([]);
    expect(readFileSync(catalogPath)).toEqual(before);
  });

  it('publishes capability truth without exposing provider checkpoint references', async () => {
    const response = await transformRoute.GET(new NextRequest(
      `http://localhost/api/runtime/session-transform?runtimeId=opencode&sessionKey=${encodeURIComponent(rootSession.sessionKey)}`,
    ));
    expect(response.status).toBe(200);
    const body = await response.json() as {
      capabilities: Record<string, { supported: boolean }>;
      checkpoints: Array<Record<string, unknown>>;
      receipts: Array<Record<string, unknown>>;
    };
    expect(body.capabilities.rewind?.supported).toBe(true);
    expect(body.checkpoints.length).toBeGreaterThan(0);
    expect(body.checkpoints.every((checkpoint) => !('providerRef' in checkpoint))).toBe(true);
    expect(body.receipts.every((receipt) => !('clientMutationId' in receipt))).toBe(true);
  });

  it('returns structured unsupported truth without creating a partial catalog entry', async () => {
    const catalogPath = path.join(dataDir, 'session-transform-catalog.json');
    const before = readFileSync(catalogPath);
    const beforeVersion = (JSON.parse(before.toString('utf8')) as { version: number }).version;
    const response = await postTransform({
      action: 'import',
      runtimeId: 'aider',
      sessionKey: 'aider:unsupported-fixture',
      expectedCatalogVersion: beforeVersion,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ reason: 'unsupported', retryable: false });
    expect(readFileSync(catalogPath)).toEqual(before);
  });

  it('requires a body-bound mutation id and returns truthful in-progress, replay, and conflict responses', async () => {
    const missingId = await transformRoute.POST(transformRequest({
      action: 'checkpoint',
      runtimeId: 'opencode',
      sessionKey: rootSession.sessionKey,
      expectedCatalogVersion: 9,
    }) as never);
    expect(missingId.status).toBe(400);
    expect(await missingId.json()).toMatchObject({ reason: 'invalid_request' });

    let releaseCheckpoint!: () => void;
    holdNextCheckpoint = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
    const body = {
      action: 'checkpoint',
      runtimeId: 'opencode',
      sessionKey: rootSession.sessionKey,
      expectedCatalogVersion: 9,
      clientMutationId: 'session-transform-idempotency-live',
    };
    const firstPromise = transformRoute.POST(transformRequest(body) as never);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const duplicate = await transformRoute.POST(transformRequest(body) as never);
    expect(duplicate.status).toBe(202);
    expect(duplicate.headers.get('x-o8-idempotency-replayed')).toBe('1');
    expect(await duplicate.json()).toMatchObject({
      status: 'in_progress',
      inProgress: true,
      replayed: true,
      clientMutationId: body.clientMutationId,
    });

    releaseCheckpoint();
    holdNextCheckpoint = null;
    const first = await firstPromise;
    expect(first.status).toBe(200);
    const replay = await transformRoute.POST(transformRequest(body) as never);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('x-o8-idempotency-replayed')).toBe('1');
    expect(await replay.json()).toMatchObject({
      replayed: true,
      clientMutationId: body.clientMutationId,
      catalogVersion: 10,
    });

    const conflict = await transformRoute.POST(transformRequest({
      ...body,
      action: 'import',
    }) as never);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ reason: 'mutation_conflict' });
  });

  it('retains provider_started intent after an ambiguous retryable fork failure', async () => {
    const ambiguousSession: RuntimeSession = {
      ...rootSession,
      sessionKey: 'opencode:fixture-ambiguous-root',
      displayName: 'Fixture ambiguous root',
    };
    sessions.set(ambiguousSession.sessionKey, ambiguousSession);
    expect((await postTransform({
      action: 'import',
      runtimeId: 'opencode',
      sessionKey: ambiguousSession.sessionKey,
      expectedCatalogVersion: 10,
    })).status).toBe(200);
    const checkpointResponse = await postTransform({
      action: 'checkpoint',
      runtimeId: 'opencode',
      sessionKey: ambiguousSession.sessionKey,
      expectedCatalogVersion: 11,
    });
    const checkpoint = await checkpointResponse.json() as { checkpointId: string };
    const catalogPath = path.join(dataDir, 'session-transform-catalog.json');
    const before = readFileSync(catalogPath);

    failNextForkAmbiguously = true;
    const failed = await postTransform({
      action: 'fork',
      runtimeId: 'opencode',
      sessionKey: ambiguousSession.sessionKey,
      checkpointId: checkpoint.checkpointId,
      expectedCatalogVersion: 12,
    });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ reason: 'provider_error', retryable: true });
    expect(readFileSync(catalogPath)).toEqual(before);

    const { readSessionTransformIntents } = await import('@/lib/runtime/session-transform-catalog');
    expect(await readSessionTransformIntents()).toEqual([
      expect.objectContaining({
        originalSessionKey: ambiguousSession.sessionKey,
        phase: 'provider_started',
        result: null,
      }),
    ]);
    const state = await transformRoute.GET(new NextRequest(
      `http://localhost/api/runtime/session-transform?runtimeId=opencode&sessionKey=${encodeURIComponent(ambiguousSession.sessionKey)}`,
    ));
    expect(await state.json()).toMatchObject({
      pendingTransform: { phase: 'provider_started', manualResolutionRequired: true },
    });
  });
});
