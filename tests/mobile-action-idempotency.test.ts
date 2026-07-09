import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const runtimeMocks = vi.hoisted(() => ({
  launchCodexFromMobile: vi.fn(),
  launchRuntimeSurface: vi.fn(),
  performRuntimeAction: vi.fn(),
}));

vi.mock('@/lib/runtime/actions', () => runtimeMocks);
vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));
vi.mock('@/lib/command-center/snapshot', () => ({
  invalidateCommandCenterSnapshotCaches: vi.fn(),
}));
vi.mock('@/lib/mobile/inbox', () => ({
  invalidateInboxCache: vi.fn(),
}));

const actionRoute = await import('@/app/api/mobile/action/route');
const { __resetIdempotencyStoreForTests } = await import('@/lib/orchestrator/idempotency-store');

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3001/api/mobile/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('mobile action persisted idempotency', () => {
  beforeEach(() => {
    __resetIdempotencyStoreForTests();
    vi.clearAllMocks();
  });

  it('returns 202 for an in-flight duplicate and exactly replays a completed response', async () => {
    let resolveLaunch: ((value: {
      ok: true;
      action: 'launch';
      surfaceId: string;
      runtime: 'codex';
      status: 'queued';
      note: string;
    }) => void) | undefined;
    runtimeMocks.launchCodexFromMobile.mockImplementationOnce(() => new Promise((resolve) => {
      resolveLaunch = resolve;
    }));

    const body = {
      action: 'launch',
      sessionKey: 'launch:new',
      clientMutationId: 'mobile-launch-1',
      cwd: '/tmp/repo',
      message: 'Run the packet',
    };

    const firstPromise = actionRoute.POST(post(body));
    await vi.waitFor(() => expect(runtimeMocks.launchCodexFromMobile).toHaveBeenCalledTimes(1));

    const duplicateInFlight = await actionRoute.POST(post(body));
    expect(duplicateInFlight.status).toBe(202);
    expect(await duplicateInFlight.json()).toMatchObject({
      ok: true,
      status: 'queued',
      duplicate: true,
      inProgress: true,
      clientMutationId: 'mobile-launch-1',
    });
    expect(runtimeMocks.launchCodexFromMobile).toHaveBeenCalledTimes(1);

    resolveLaunch?.({
      ok: true,
      action: 'launch',
      surfaceId: 'codex-owned:new',
      runtime: 'codex',
      status: 'queued',
      note: 'Launch queued.',
    });
    const first = await firstPromise;
    const firstBody = await first.json();
    expect(first.status).toBe(200);

    const completedReplay = await actionRoute.POST(post(body));
    expect(completedReplay.status).toBe(200);
    expect(completedReplay.headers.get('x-o8-idempotency-replayed')).toBe('1');
    expect(await completedReplay.json()).toEqual(firstBody);
    expect(runtimeMocks.launchCodexFromMobile).toHaveBeenCalledTimes(1);
  });

  it('leaves legacy no-id calls outside the persisted guard', async () => {
    runtimeMocks.launchCodexFromMobile.mockResolvedValue({
      ok: true,
      action: 'launch',
      surfaceId: 'codex-owned:new',
      runtime: 'codex',
      status: 'queued',
      note: 'Launch queued.',
    });
    const body = {
      action: 'launch',
      sessionKey: 'launch:new',
      cwd: '/tmp/repo',
      message: 'Run the packet',
    };

    await actionRoute.POST(post(body));
    await actionRoute.POST(post(body));

    expect(runtimeMocks.launchCodexFromMobile).toHaveBeenCalledTimes(2);
  });
});
