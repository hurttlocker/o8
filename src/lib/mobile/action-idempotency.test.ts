import { describe, expect, it } from 'vitest';

import {
  MobileActionUncacheableResponseError,
  mobileActionInProgressPayload,
  resolveMobileActionIdempotencyIdentity,
  restoreMobileActionResponse,
  serializeCacheableMobileActionResponse,
  serializeMobileActionResponse,
} from './action-idempotency';

describe('mobile action idempotency helpers', () => {
  it('only enables persistence for an explicit nonblank clientMutationId', () => {
    expect(resolveMobileActionIdempotencyIdentity({ action: 'stop', sessionKey: 's' })).toBeNull();
    expect(resolveMobileActionIdempotencyIdentity({
      action: 'stop',
      sessionKey: 's',
      clientMutationId: '   ',
    })).toBeNull();

    expect(resolveMobileActionIdempotencyIdentity({
      action: ' approve ',
      sessionKey: ' session-1 ',
      approvalId: ' approval-1 ',
      clientMutationId: ' mutation-1 ',
    })).toEqual({
      action: 'approve',
      sessionKey: 'session-1',
      clientMutationId: 'mutation-1',
      scopeId: JSON.stringify(['approve', 'approval-1', 'session-1']),
      canonicalBody: JSON.stringify({
        action: 'approve',
        sessionKey: 'session-1',
        approvalId: 'approval-1',
      }),
    });
  });

  it('round-trips status, body, and headers for completed replay', async () => {
    const original = new Response(JSON.stringify({ ok: false, error: 'conflict' }), {
      status: 409,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    });
    const stored = await serializeMobileActionResponse(original);
    const replay = restoreMobileActionResponse(stored, { replayed: true });

    expect(replay.status).toBe(409);
    expect(replay.headers.get('cache-control')).toBe('no-store');
    expect(replay.headers.get('x-o8-idempotency-replayed')).toBe('1');
    expect(await replay.json()).toEqual({ ok: false, error: 'conflict' });
  });

  it('rejects server failures so the execution reservation stays retryable', async () => {
    await expect(serializeCacheableMobileActionResponse(new Response('temporary failure', {
      status: 501,
    }))).rejects.toBeInstanceOf(MobileActionUncacheableResponseError);
  });

  it('persists an explicitly terminal outcome-unknown server receipt', async () => {
    const response = new Response('outcome unknown', {
      status: 500,
      headers: { 'x-o8-terminal-outcome': 'unknown' },
    });
    await expect(serializeCacheableMobileActionResponse(response)).resolves.toMatchObject({
      status: 500,
      body: 'outcome unknown',
    });
  });

  it('shapes an honest accepted-but-still-running duplicate', () => {
    const identity = resolveMobileActionIdempotencyIdentity({
      action: 'launch',
      sessionKey: 'launch:new',
      clientMutationId: 'mutation-2',
    });
    expect(identity).not.toBeNull();
    expect(mobileActionInProgressPayload(identity!)).toMatchObject({
      ok: true,
      status: 'queued',
      duplicate: true,
      inProgress: true,
      clientMutationId: 'mutation-2',
    });
  });
});
