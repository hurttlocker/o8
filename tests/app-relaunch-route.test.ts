import { beforeEach, describe, expect, it, vi } from 'vitest';

const publishRealtimeMutation = vi.fn<(request: unknown) => Promise<void>>(async () => undefined);

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation,
}));

async function postUpdateState(body: unknown) {
  const { POST } = await import('@/app/api/panel/app/update-state/route');
  return POST(new Request('http://127.0.0.1/api/panel/app/update-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

async function postRelaunch(body: unknown) {
  const { POST } = await import('@/app/api/panel/app/relaunch/route');
  return POST(new Request('http://127.0.0.1/api/panel/app/relaunch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('POST /api/panel/app/relaunch', () => {
  beforeEach(async () => {
    publishRealtimeMutation.mockClear();
    await postUpdateState({ updatePending: false });
  });

  it('no-ops clearly when --if-update-pending is requested with no pending update', async () => {
    const res = await postRelaunch({ ifUpdatePending: true });
    const data = await res.json() as { skipped?: boolean; reason?: string; message?: string };

    expect(res.status).toBe(200);
    expect(data.skipped).toBe(true);
    expect(data.reason).toBe('no-update-pending');
    expect(data.message).toMatch(/restart skipped/i);
    expect(publishRealtimeMutation).not.toHaveBeenCalled();
  });

  it('publishes the realtime mutation when an update is pending', async () => {
    await postUpdateState({ updatePending: true, version: '0.1.999' });
    const res = await postRelaunch({ ifUpdatePending: true });
    const data = await res.json() as { relaunched?: boolean; state?: { version?: string | null } };

    expect(res.status).toBe(200);
    expect(data.relaunched).toBe(true);
    expect(data.state?.version).toBe('0.1.999');
    expect(publishRealtimeMutation).toHaveBeenCalledTimes(1);
    expect(publishRealtimeMutation.mock.calls[0]?.[0]).toMatchObject({
      mutation: {
        source: 'server',
        action: 'app-relaunch-requested',
        status: 'queued',
      },
    });
  });
});
