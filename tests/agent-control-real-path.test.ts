import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { AgentControlRequest, AgentControlResult } from '@/lib/agent-control/types';

const h = vi.hoisted(() => ({
  perform: vi.fn<(request: AgentControlRequest) => Promise<AgentControlResult>>(async (request) => ({
    schema: 'o8/agent-control.result/v1' as const,
    ok: true,
    ref: request.ref,
    action: request.action.kind,
    clientMutationId: request.clientMutationId,
    status: 'completed' as const,
    note: 'Controlled once.',
    target: {
      schema: 'o8/agent-control.target/v1' as const,
      canonicalRef: request.ref,
      resolution: 'request' as const,
      runtime: null,
      surfaceId: request.ref.kind === 'session' ? request.ref.id : null,
      sessionKey: request.ref.kind === 'session' ? request.ref.id : null,
      projectId: null,
      repoPath: null,
      worktreePath: null,
      branch: null,
      baseBranch: null,
      laneId: request.ref.kind === 'lane' ? request.ref.id : null,
      laneStatus: null,
      packetId: request.ref.kind === 'packet' ? request.ref.id : null,
      packetStatus: null,
      approval: { id: null, status: 'none' as const },
    },
  })),
  resolve: vi.fn(async (ref: AgentControlRequest['ref']) => ({
    schema: 'o8/agent-control.target/v1' as const,
    canonicalRef: ref,
    resolution: 'request' as const,
    runtime: null,
    surfaceId: ref.kind === 'session' ? ref.id : null,
    sessionKey: ref.kind === 'session' ? ref.id : null,
    projectId: null,
    repoPath: null,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    laneId: ref.kind === 'lane' ? ref.id : null,
    laneStatus: null,
    packetId: ref.kind === 'packet' ? ref.id : null,
    packetStatus: null,
    approval: { id: null, status: 'none' as const },
  })),
}));

vi.mock('@/lib/agent-control/service', () => ({
  performAgentControlAction: h.perform,
  resolveAgentControlTarget: h.resolve,
}));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-agent-control-'));
const operatorToken = 'operator-agent-control-0123456789abcdef';
const workerToken = 'local-worker-token-agent-control-0123456789abcdef';
const deviceToken = 'device-agent-control-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');
writeFileSync(join(dataDir, 'worker-token'), `${workerToken}\n`, 'utf8');
writeFileSync(
  join(dataDir, 'mobile-device-tokens'),
  `${createHash('sha256').update(deviceToken).digest('hex')}\n`,
  'utf8',
);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const route = await import('@/app/api/agent-control/action/route');
const idempotency = await import('@/lib/orchestrator/idempotency-store');
const { closeDb } = await import('@/lib/db');
const { panelGateMiddleware } = await import('@/middleware');

function post(token: string | null, body: unknown) {
  return new NextRequest('http://localhost:3001/api/agent-control/action', {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function json(response: Response) {
  return await response.json() as Record<string, unknown>;
}

describe('agent control through the real route', () => {
  beforeEach(() => {
    h.perform.mockClear();
    h.resolve.mockClear();
  });

  it('persists an operator mutation key and replays the result without a second action', async () => {
    const body = {
      ref: { kind: 'session', id: 'codex-owned:route-1' },
      action: { kind: 'interrupt' },
      clientMutationId: 'agent-control-route-once',
    };

    const first = await json(await route.POST(post(operatorToken, body)));
    const second = await json(await route.POST(post(operatorToken, body)));

    expect(first.ok).toBe(true);
    expect((first.result as Record<string, unknown>).replayed).toBeUndefined();
    expect((second.result as Record<string, unknown>).replayed).toBe(true);
    expect(h.perform).toHaveBeenCalledTimes(1);
  });

  it('returns a structured error when persisted mutation binding throws', async () => {
    const bind = vi.spyOn(idempotency, 'bindIdempotencyClientMutation').mockImplementationOnce(() => {
      throw new Error('agent control idempotency write failed');
    });
    try {
      const response = await route.POST(post(operatorToken, {
        ref: { kind: 'session', id: 'codex-owned:binding-failure' },
        action: { kind: 'interrupt' },
        clientMutationId: 'agent-control-binding-failure',
      }));

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { code: 'agent_control_failed', message: 'agent control idempotency write failed' },
      });
      expect(h.perform).not.toHaveBeenCalled();
    } finally {
      bind.mockRestore();
    }
  });

  it('returns a queued control result while an identical mutation is still running', async () => {
    let finish!: (result: AgentControlResult) => void;
    const pending = new Promise<AgentControlResult>((resolve) => {
      finish = resolve;
    });
    h.perform.mockImplementationOnce(async () => pending);
    const body = {
      ref: { kind: 'session', id: 'codex-owned:route-in-progress' },
      action: { kind: 'interrupt' },
      clientMutationId: 'agent-control-route-in-progress',
    } as const;

    const firstPromise = route.POST(post(operatorToken, body));
    await vi.waitFor(() => expect(h.perform).toHaveBeenCalledTimes(1));
    const duplicate = await route.POST(post(operatorToken, body));

    expect(duplicate.status).toBe(202);
    expect(await json(duplicate)).toMatchObject({
      ok: true,
      result: {
        schema: 'o8/agent-control.result/v1',
        ok: true,
        ref: body.ref,
        action: 'interrupt',
        status: 'queued',
        target: {
          schema: 'o8/agent-control.target/v1',
          canonicalRef: body.ref,
        },
        replayed: true,
        inProgress: true,
      },
    });
    expect(h.perform).toHaveBeenCalledTimes(1);

    finish({
      schema: 'o8/agent-control.result/v1',
      ok: true,
      ref: body.ref,
      action: 'interrupt',
      clientMutationId: body.clientMutationId,
      status: 'completed',
      note: 'Controlled once.',
      target: await h.resolve(body.ref),
    });
    expect((await firstPromise).status).toBe(200);
  });

  it('conflicts when an explicit mutation id is reused with a changed body after restart', async () => {
    const firstBody = {
      ref: { kind: 'session', id: 'codex-owned:route-conflict' },
      action: { kind: 'send', message: 'first message' },
      clientMutationId: 'agent-control-route-conflict',
    };
    const changedBody = {
      ...firstBody,
      action: { kind: 'send', message: 'changed message' },
    };

    expect((await route.POST(post(operatorToken, firstBody))).status).toBe(200);
    closeDb();
    const conflict = await route.POST(post(operatorToken, changedBody));
    expect(conflict.status).toBe(409);
    expect(await json(conflict)).toMatchObject({
      ok: false,
      error: { code: 'idempotency_conflict' },
    });
    expect(h.perform).toHaveBeenCalledTimes(1);
  });

  it('conflicts when an explicit mutation id is reused for another target', async () => {
    const firstBody = {
      ref: { kind: 'session', id: 'codex-owned:first-target' },
      action: { kind: 'interrupt' },
      clientMutationId: 'agent-control-target-conflict',
    };
    const changedTarget = {
      ...firstBody,
      ref: { kind: 'session', id: 'codex-owned:second-target' },
    };

    expect((await route.POST(post(operatorToken, firstBody))).status).toBe(200);
    const conflict = await route.POST(post(operatorToken, changedTarget));
    expect(conflict.status).toBe(409);
    expect(await json(conflict)).toMatchObject({
      ok: false,
      error: { code: 'idempotency_conflict' },
    });
    expect(h.perform).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      ref: { kind: 'session', id: 'codex-owned:missing-id' },
      action: { kind: 'send', message: 'repeatable' },
    },
    {
      ref: { kind: 'lane', id: 'lane-missing-id' },
      action: { kind: 'send_turn', message: 'repeatable' },
    },
    {
      ref: { kind: 'packet', id: 'packet-steer-missing-id' },
      action: { kind: 'steer', message: 'repeatable' },
    },
    {
      ref: { kind: 'packet', id: 'packet-rerun-missing-id' },
      action: { kind: 'rerun', feedback: 'repeatable' },
    },
    {
      ref: { kind: 'session', id: 'codex-owned:interrupt-missing-id' },
      action: { kind: 'interrupt' },
    },
    {
      ref: { kind: 'session', id: 'codex-owned:watch-missing-id' },
      action: { kind: 'watch' },
    },
    {
      ref: { kind: 'session', id: 'codex-owned:resolve-missing-id' },
      action: { kind: 'resolve' },
    },
    {
      ref: { kind: 'lane', id: 'lane-interrupt-missing-id' },
      action: { kind: 'interrupt' },
    },
    {
      ref: { kind: 'lane', id: 'lane-hold-missing-id' },
      action: { kind: 'hold' },
    },
    {
      ref: { kind: 'packet', id: 'packet-reset-missing-id' },
      action: { kind: 'reset' },
    },
    {
      ref: { kind: 'packet', id: 'packet-retry-missing-id' },
      action: { kind: 'retry' },
    },
    {
      ref: { kind: 'packet', id: 'packet-terminate-missing-id' },
      action: { kind: 'terminate' },
    },
    {
      ref: { kind: 'packet', id: 'packet-merge-missing-id' },
      action: { kind: 'merge' },
    },
  ])('requires clientMutationId for control action $action.kind', async (body) => {
    const response = await route.POST(post(operatorToken, body));
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: 'client_mutation_id_required' },
    });
    expect(h.perform).not.toHaveBeenCalled();
  });

  it('executes two intentional repeated messages when they carry distinct mutation ids', async () => {
    const base = {
      ref: { kind: 'session', id: 'codex-owned:repeat-message' },
      action: { kind: 'send', message: 'run that check again' },
    };

    expect((await route.POST(post(operatorToken, { ...base, clientMutationId: 'repeat-message-1' }))).status).toBe(200);
    expect((await route.POST(post(operatorToken, { ...base, clientMutationId: 'repeat-message-2' }))).status).toBe(200);
    expect(h.perform).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ref: { kind: 'session', id: 'codex-owned:repeat-interrupt' }, action: { kind: 'interrupt' } },
    { ref: { kind: 'packet', id: 'packet-repeat-retry' }, action: { kind: 'retry' } },
    { ref: { kind: 'packet', id: 'packet-repeat-merge' }, action: { kind: 'merge' } },
  ])('executes repeated $action.kind controls with distinct mutation ids', async (base) => {
    expect((await route.POST(post(operatorToken, { ...base, clientMutationId: `${base.action.kind}-1` }))).status).toBe(200);
    expect((await route.POST(post(operatorToken, { ...base, clientMutationId: `${base.action.kind}-2` }))).status).toBe(200);
    expect(h.perform).toHaveBeenCalledTimes(2);
  });

  it('replays an unavailable terminal receipt without repeating the mutation', async () => {
    const body = {
      ref: { kind: 'session', id: 'codex-owned:route-retry' },
      action: { kind: 'interrupt' },
      clientMutationId: 'agent-control-route-retry',
    } as const;
    h.perform.mockResolvedValueOnce({
      schema: 'o8/agent-control.result/v1',
      ok: false,
      ref: body.ref,
      action: body.action.kind,
      clientMutationId: body.clientMutationId,
      status: 'unavailable',
      note: 'Surface is still starting.',
      retryable: true,
      target: await h.resolve(body.ref),
    });

    const unavailable = await route.POST(post(operatorToken, body));
    expect(unavailable.status).toBe(409);
    expect(await json(unavailable)).toMatchObject({
      ok: false,
      result: { status: 'unavailable', retryable: true },
    });
    const replay = await route.POST(post(operatorToken, body));
    expect(replay.status).toBe(409);
    expect(await json(replay)).toMatchObject({
      ok: false,
      result: { status: 'unavailable', retryable: true, replayed: true },
    });
    expect(h.perform).toHaveBeenCalledTimes(1);
  });

  it('persists a thrown outcome as unknown and never repeats the exact mutation', async () => {
    const body = {
      ref: { kind: 'session', id: 'codex-owned:ambiguous-send' },
      action: { kind: 'send', message: 'continue once' },
      clientMutationId: 'agent-control-ambiguous-send',
    } as const;
    h.perform.mockRejectedValueOnce(new Error('provider response was lost after send'));

    const first = await route.POST(post(operatorToken, body));
    const replay = await route.POST(post(operatorToken, body));

    expect(first.status).toBe(409);
    expect(replay.status).toBe(409);
    expect(await json(first)).toMatchObject({
      ok: false,
      result: { reason: 'outcome_unknown', retryable: false },
    });
    expect(await json(replay)).toMatchObject({
      ok: false,
      result: { reason: 'outcome_unknown', retryable: false, replayed: true },
    });
    expect(h.perform).toHaveBeenCalledTimes(1);
  });

  it('rejects worker and anonymous principals before the service can mutate', async () => {
    const body = {
      ref: { kind: 'packet', id: 'pkt-other' },
      action: { kind: 'terminate' },
    };

    expect((await route.POST(post(workerToken, body))).status).toBe(403);
    expect((await route.POST(post(null, body))).status).toBe(401);
    expect(h.perform).not.toHaveBeenCalled();
  });

  it('keeps the new route operator-only at middleware and handler boundaries', async () => {
    const request = post(deviceToken, {
      ref: { kind: 'session', id: 'codex-owned:device-1' },
      action: { kind: 'watch' },
      clientMutationId: 'device-watch-1',
    });
    const middlewareResponse = panelGateMiddleware(request);
    const handlerResponse = await route.POST(request);

    expect(middlewareResponse.status).toBe(403);
    expect(handlerResponse.status).toBe(403);
    expect(h.perform).not.toHaveBeenCalled();
  });

  it('fails closed when a ref and action belong to different control layers', async () => {
    const response = await route.POST(post(operatorToken, {
      ref: { kind: 'session', id: 'codex-owned:route-2' },
      action: { kind: 'terminate' },
    }));

    expect(response.status).toBe(400);
    expect(h.perform).not.toHaveBeenCalled();
  });

  it('rejects malformed session attachments before the service can mutate', async () => {
    const response = await route.POST(post(operatorToken, {
      ref: { kind: 'session', id: 'codex-owned:route-3' },
      action: {
        kind: 'send',
        message: 'inspect this',
        attachments: [{ fileName: 'missing-content.txt', mimeType: 'text/plain' }],
      },
      clientMutationId: 'malformed-attachment-1',
    }));

    expect(response.status).toBe(400);
    expect(h.perform).not.toHaveBeenCalled();
  });
});
