import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  kill: vi.fn(),
  archiveSessions: vi.fn(),
  archiveLane: vi.fn(),
  listActiveLanes: vi.fn(),
  listLanes: vi.fn(),
  reset: vi.fn(),
}));

vi.mock('@/lib/lane/reap-sessions', () => ({
  interruptLaneSessions: vi.fn(),
  killLaneSessionsConfirmed: h.kill,
  archiveLaneSessions: h.archiveSessions,
}));
vi.mock('@/lib/lane/registry', () => ({
  archiveLane: h.archiveLane,
  listActiveLanes: h.listActiveLanes,
  listLanes: h.listLanes,
}));
vi.mock('@/lib/orchestrator/operator-mission-service', () => ({ resetPacket: h.reset }));
vi.mock('@/lib/orchestrator/control-plane', () => ({
  readOrchestratorControlPlaneState: vi.fn(() => ({ packets: [] })),
  withLockedState: vi.fn(async (mutate: (state: { missionId: string; packets: unknown[] }) => unknown) => {
    const state = { missionId: '', packets: [] };
    return { state, result: await mutate(state) };
  }),
}));
vi.mock('@/lib/orchestrator/mission-registry', () => ({
  findMissionRegistryEntryByPacketId: vi.fn(() => null),
}));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: vi.fn(() => null) }));

const { stopAllLanes, stopPacket } = await import('@/lib/orchestrator/stop-packet');
const stopRoute = await import('@/app/api/orchestrator/stop-packet/route');

describe('concurrent packet stop truth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.listActiveLanes.mockReturnValue([]);
    h.listLanes.mockReturnValue([]);
    h.archiveSessions.mockResolvedValue({ targeted: 0, archived: 0, outcomes: [], failures: [] });
    h.archiveLane.mockImplementation((laneId: string) => ({ id: laneId, status: 'archived' }));
  });

  it('shares the unresolved stop result instead of claiming a second confirmed kill', async () => {
    let finishKill!: (value: Array<Record<string, unknown>>) => void;
    h.listLanes.mockReturnValue([{
      id: 'lane-concurrent-stop',
      packetId: 'packet-concurrent-stop',
      sessionKey: 'codex-owned:concurrent-stop',
    }]);
    h.kill.mockImplementationOnce(() => new Promise((resolve) => {
      finishKill = resolve;
    }));

    const first = stopPacket('packet-concurrent-stop');
    const second = stopPacket('packet-concurrent-stop');
    expect(second).toBe(first);
    await vi.waitFor(() => expect(h.kill).toHaveBeenCalledTimes(1));

    finishKill([{
      laneId: 'lane-concurrent-stop',
      sessionKey: 'codex-owned:concurrent-stop',
      pid: 123,
      confirmed: false,
      alreadyDead: false,
    }]);

    await expect(first).resolves.toMatchObject({
      ok: false,
      killConfirmed: false,
      blockedReason: 'kill_unconfirmed',
    });
    await expect(second).resolves.toMatchObject({
      ok: false,
      killConfirmed: false,
      blockedReason: 'kill_unconfirmed',
    });
    expect(h.reset).not.toHaveBeenCalled();
  });

  it('keeps sharing the confirmed receipt while its background cleanup is still running', async () => {
    let finishCleanup!: (value: { reset: boolean; salvaged: boolean }) => void;
    h.listLanes.mockReturnValue([{
      id: 'lane-stop-cleanup-shared',
      packetId: 'packet-stop-cleanup-shared',
      sessionKey: 'codex-owned:stop-cleanup-shared',
    }]);
    h.kill.mockResolvedValueOnce([{
      laneId: 'lane-stop-cleanup-shared',
      sessionKey: 'codex-owned:stop-cleanup-shared',
      confirmed: true,
      alreadyDead: false,
    }]);
    h.reset.mockImplementationOnce(() => new Promise((resolve) => {
      finishCleanup = resolve;
    }));

    const first = stopPacket('packet-stop-cleanup-shared');
    await expect(first).resolves.toMatchObject({ ok: true, killConfirmed: true });
    const second = stopPacket('packet-stop-cleanup-shared');
    expect(second).toBe(first);
    await expect(second).resolves.toMatchObject({ ok: true, killConfirmed: true });
    expect(h.kill).toHaveBeenCalledTimes(1);
    expect(h.reset).toHaveBeenCalledTimes(1);

    finishCleanup({ reset: true, salvaged: false });
    await vi.waitFor(() => expect(h.reset).toHaveBeenCalledTimes(1));
  });

  it('keeps an unconfirmed orphan visible and reports stop-all as incomplete', async () => {
    const orphan = {
      id: 'lane-orphan-survivor',
      packetId: null,
      repoPath: '/repo/orphan',
      sessionKey: 'opencode-owned:orphan-survivor',
      runtime: 'opencode',
    };
    h.listActiveLanes.mockReturnValue([orphan]);
    h.kill.mockResolvedValueOnce([{
      laneId: orphan.id,
      sessionKey: orphan.sessionKey,
      confirmed: false,
      alreadyDead: false,
    }]);

    await expect(stopAllLanes()).resolves.toMatchObject({
      ok: false,
      stoppedPackets: 0,
      failedPackets: 0,
      archivedLanes: 0,
      failedLanes: 1,
    });
    expect(h.archiveLane).not.toHaveBeenCalled();
  });

  it('archives an orphan with no session because there is no process to confirm', async () => {
    const orphan = {
      id: 'lane-orphan-no-session',
      packetId: null,
      repoPath: '/repo/orphan-no-session',
      sessionKey: null,
      runtime: 'codex',
    };
    h.listActiveLanes.mockReturnValue([orphan]);
    h.kill.mockResolvedValueOnce([]);

    await expect(stopAllLanes()).resolves.toMatchObject({
      ok: true,
      archivedLanes: 1,
      failedLanes: 0,
    });
    expect(h.archiveLane).toHaveBeenCalledWith(orphan.id, 'user');
  });

  it('keeps an owned orphan visible when its session directory cannot be archived', async () => {
    const orphan = {
      id: 'lane-orphan-session-archive-failure',
      packetId: null,
      repoPath: '/repo/orphan-session-archive-failure',
      sessionKey: 'opencode-owned:orphan-session-archive-failure',
      runtime: 'opencode',
    };
    h.listActiveLanes.mockReturnValue([orphan]);
    h.kill.mockResolvedValueOnce([{
      laneId: orphan.id,
      sessionKey: orphan.sessionKey,
      confirmed: true,
      alreadyDead: false,
    }]);
    h.archiveSessions.mockResolvedValueOnce({
      targeted: 1,
      archived: 0,
      outcomes: [{
        laneId: orphan.id,
        sessionKey: orphan.sessionKey,
        runtime: orphan.runtime,
        archived: false,
        note: 'archive failed',
      }],
      failures: [{
        laneId: orphan.id,
        sessionKey: orphan.sessionKey,
        runtime: orphan.runtime,
        archived: false,
        note: 'archive failed',
      }],
    });

    await expect(stopAllLanes()).resolves.toMatchObject({
      ok: false,
      archivedLanes: 0,
      failedLanes: 1,
    });
    expect(h.archiveLane).not.toHaveBeenCalled();
  });

  it('returns structured conflict truth when stop-all cannot confirm every worker', async () => {
    const orphan = {
      id: 'lane-route-orphan-survivor',
      packetId: null,
      repoPath: '/repo/orphan',
      sessionKey: 'opencode-owned:route-orphan-survivor',
      runtime: 'opencode',
    };
    h.listActiveLanes.mockReturnValue([orphan]);
    h.kill.mockResolvedValueOnce([{
      laneId: orphan.id,
      sessionKey: orphan.sessionKey,
      confirmed: false,
      alreadyDead: false,
    }]);
    const response = await stopRoute.POST(new NextRequest('http://localhost/api/orchestrator/stop-packet', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ all: true }),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'kill_unconfirmed' },
    });
    expect(h.archiveLane).not.toHaveBeenCalled();
  });

  it('waits for packet cleanup and reports a background archive failure', async () => {
    const lane = {
      id: 'lane-cleanup-failure',
      packetId: 'packet-cleanup-failure',
      repoPath: '/repo/cleanup-failure',
      sessionKey: 'codex-owned:cleanup-failure',
      runtime: 'codex',
    };
    h.listActiveLanes.mockReturnValue([lane]);
    h.listLanes.mockReturnValue([lane]);
    h.kill
      .mockResolvedValueOnce([{
        laneId: lane.id,
        sessionKey: lane.sessionKey,
        confirmed: true,
        alreadyDead: false,
      }])
      .mockResolvedValueOnce([]);
    h.reset.mockRejectedValueOnce(new Error('archive failed'));

    await expect(stopAllLanes()).resolves.toMatchObject({
      ok: false,
      stoppedPackets: 0,
      failedPackets: 1,
      archivedLanes: 0,
      failedLanes: 1,
    });
  });
});
