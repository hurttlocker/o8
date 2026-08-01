import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getUpdateIdleWindow, publishRealtimeMutation } = vi.hoisted(() => ({
  getUpdateIdleWindow: vi.fn(),
  publishRealtimeMutation: vi.fn(async () => true),
}));

vi.mock('@/lib/app-update/idle-window', () => ({ getUpdateIdleWindow }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation }));

const { setAppUpdateState } = await import('@/lib/app-update/relaunch-state');
const updateApplyRoute = await import('@/app/api/panel/update/apply/route');

function request(body: unknown) {
  return new Request('http://127.0.0.1/api/panel/update/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/panel/update/apply real route', () => {
  beforeEach(() => {
    publishRealtimeMutation.mockClear();
    getUpdateIdleWindow.mockReset();
    setAppUpdateState({ updatePending: true, version: '0.1.999' });
  });

  it('refuses while work is live and returns the active lane/session inventory', async () => {
    getUpdateIdleWindow.mockResolvedValue({
      idle: false,
      active: {
        lanes: [{
          id: 'lane-live',
          label: 'Live worker',
          status: 'running',
          runtime: 'codex',
          sessionKey: 'codex-owned:live',
        }],
        terminalSessions: [{
          name: 'worker-pty',
          kind: 'managed-process',
          clientCount: 0,
          cwd: '/tmp/repo',
          commandHint: 'codex exec',
        }],
        managedRuns: [],
        ownedSessions: [],
      },
      unavailable: [],
      checkedAt: '2026-07-31T12:00:00.000Z',
    });

    const response = await updateApplyRoute.POST(request({}));
    const payload = await response.json() as {
      error?: { code?: string };
      idle?: { active?: { lanes?: unknown[]; terminalSessions?: unknown[] } };
    };

    expect(response.status).toBe(409);
    expect(payload.error?.code).toBe('update_apply_busy');
    expect(payload.idle?.active?.lanes).toHaveLength(1);
    expect(payload.idle?.active?.terminalSessions).toHaveLength(1);
    expect(publishRealtimeMutation).not.toHaveBeenCalled();
  });

  it('publishes the webview command only when force explicitly overrides the same busy state', async () => {
    getUpdateIdleWindow.mockResolvedValue({
      idle: false,
      active: { lanes: [], terminalSessions: [], managedRuns: [], ownedSessions: [] },
      unavailable: ['terminal-sessions'],
      checkedAt: '2026-07-31T12:00:00.000Z',
    });

    const response = await updateApplyRoute.POST(request({ force: true }));
    expect(response.status).toBe(202);
    expect(publishRealtimeMutation).toHaveBeenCalledWith(expect.objectContaining({
      mutation: expect.objectContaining({
        action: 'app-update-apply-requested',
        force: true,
        status: 'queued',
      }),
    }));
  });
});
