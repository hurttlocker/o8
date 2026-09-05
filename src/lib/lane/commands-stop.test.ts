import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLane, getLaneEvents } from '@/lib/lane/registry';
import { dispatch } from './commands';

const h = vi.hoisted(() => ({
  kill: vi.fn(),
  persistHold: vi.fn(),
  terminateManagedRuns: vi.fn(),
}));
vi.mock('@/lib/lane/reap-sessions', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/lane/reap-sessions')>(),
  killLaneSessionsConfirmed: h.kill,
}));
vi.mock('@/lib/runtimes/managed-runs/packet-lifecycle', () => ({
  terminatePacketManagedRuns: h.terminateManagedRuns,
}));
vi.mock('@/lib/lane/packet-stop-hold', () => ({
  persistLanePacketHold: h.persistHold,
}));

describe('lane stop command', () => {
  beforeEach(() => {
    h.kill.mockReset();
    h.persistHold.mockReset();
    h.persistHold.mockResolvedValue(true);
    h.terminateManagedRuns.mockReset();
    h.terminateManagedRuns.mockResolvedValue({ targeted: 0, confirmed: 0, failures: [] });
  });

  it('does not mark paused when the worker survives stop escalation', async () => {
    const lane = createLane({
      repoPath: process.cwd(),
      branch: 'test/stop-command',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'stop command test',
      ownership: 'managed',
      actor: 'system',
    });
    await dispatch({ verb: 'attach_session', laneId: lane.id, sessionKey: 'codex-owned:stubborn' });
    h.kill.mockResolvedValueOnce([{
      laneId: lane.id,
      sessionKey: 'codex-owned:stubborn',
      runtime: 'codex',
      confirmed: false,
      alreadyDead: false,
      stages: [{ stage: 'SIGKILL', confirmed: false, pid: 123 }],
      pid: 123,
      note: 'Worker remained live after SIGINT, SIGTERM, and SIGKILL.',
    }]);

    const result = await dispatch({ verb: 'stop', laneId: lane.id, actor: 'user' });

    expect(result.ok).toBe(false);
    expect(result.lane?.status).toBe('running');
    expect(result.lane?.lastEventLabel).toBe('interrupt_failed');
    expect(getLaneEvents(lane.id).some((event) => event.verb === 'interrupt_failed')).toBe(true);
  });

  it('marks paused only after the shared confirmed-kill path verifies exit', async () => {
    const lane = createLane({
      repoPath: process.cwd(),
      branch: 'test/stop-command-confirmed',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'confirmed stop command test',
      ownership: 'managed',
      actor: 'system',
    });
    await dispatch({ verb: 'attach_session', laneId: lane.id, sessionKey: 'codex:discovered-confirmed' });
    h.kill.mockResolvedValueOnce([{
      laneId: lane.id,
      sessionKey: 'codex:discovered-confirmed',
      runtime: 'codex',
      confirmed: true,
      alreadyDead: false,
      stages: [{ stage: 'SIGTERM', confirmed: true, pid: 456 }],
      pid: 456,
      note: 'Worker stopped after SIGTERM.',
    }]);

    const result = await dispatch({ verb: 'stop', laneId: lane.id, actor: 'user' });

    expect(result.ok).toBe(true);
    expect(result.lane).toMatchObject({ status: 'paused', lastEventLabel: 'operator_stopped' });
  });

  it('settles packet-owned managed runs on the lane command stop path', async () => {
    const packetId = 'packet-stop-managed-run';
    const lane = createLane({
      repoPath: process.cwd(),
      branch: 'test/stop-command-managed-run',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'managed run stop command test',
      ownership: 'managed',
      packetId,
      actor: 'system',
    });
    h.terminateManagedRuns.mockResolvedValueOnce({ targeted: 1, confirmed: 1, failures: [] });

    const result = await dispatch({ verb: 'stop', laneId: lane.id, actor: 'user' });

    expect(result.ok).toBe(true);
    expect(h.terminateManagedRuns).toHaveBeenCalledWith(packetId);
    expect(getLaneEvents(lane.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        verb: 'managed_runs_stopped',
        payload: expect.objectContaining({ packetId, targeted: 1, confirmed: 1 }),
      }),
    ]));
    expect(result.lane).toMatchObject({ status: 'paused', lastEventLabel: 'operator_stopped' });
  });

  it('uses a durable worker-exit receipt before settling packet-owned runs', async () => {
    const packetId = 'packet-stop-recorded-worker-exit';
    const lane = createLane({
      repoPath: process.cwd(),
      branch: 'test/stop-command-recorded-worker-exit',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'recorded worker exit stop command test',
      ownership: 'managed',
      packetId,
      actor: 'system',
    });
    await dispatch({ verb: 'attach_session', laneId: lane.id, sessionKey: 'codex-owned:exited' });
    const { recordLaneEvent } = await import('@/lib/lane/events');
    recordLaneEvent(lane.id, 'runtime_process_exit', 'system', {
      surfaceId: 'codex-owned:exited',
      exitCode: 0,
      signal: null,
      classification: 'clean-exit',
    });
    h.terminateManagedRuns.mockResolvedValueOnce({ targeted: 1, confirmed: 1, failures: [] });

    const result = await dispatch({ verb: 'stop', laneId: lane.id, actor: 'user' });

    expect(result.ok).toBe(true);
    expect(h.kill).not.toHaveBeenCalled();
    expect(h.terminateManagedRuns).toHaveBeenCalledWith(packetId);
    expect(getLaneEvents(lane.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        verb: 'managed_runs_stopped',
        payload: expect.objectContaining({ packetId, targeted: 1, confirmed: 1 }),
      }),
    ]));
  });

  it('reports failure and keeps the held lane paused when managed-run death is unconfirmed', async () => {
    const packetId = 'packet-stop-unconfirmed-managed-run';
    const lane = createLane({
      repoPath: process.cwd(),
      branch: 'test/stop-command-unconfirmed-managed-run',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'unconfirmed managed run stop command test',
      ownership: 'managed',
      packetId,
      actor: 'system',
    });
    h.terminateManagedRuns.mockResolvedValueOnce({
      targeted: 1,
      confirmed: 0,
      failures: [{
        id: 'run-stubborn',
        session: 'cortex-run-stubborn',
        reason: 'termination_unconfirmed',
      }],
    });

    const result = await dispatch({ verb: 'stop', laneId: lane.id, actor: 'user' });

    expect(result.ok).toBe(false);
    expect(result.note).toContain('could not be confirmed dead');
    expect(result.lane).toMatchObject({ status: 'paused', lastEventLabel: 'managed_run_stop_failed' });
    expect(getLaneEvents(lane.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        verb: 'managed_run_stop_failed',
        payload: expect.objectContaining({ packetId, targeted: 1, confirmed: 0 }),
      }),
    ]));
  });
});
