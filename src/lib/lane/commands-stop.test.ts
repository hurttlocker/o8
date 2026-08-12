import { describe, expect, it, vi } from 'vitest';
import { createLane, getLaneEvents } from '@/lib/lane/registry';
import { dispatch } from './commands';

const h = vi.hoisted(() => ({ kill: vi.fn() }));
vi.mock('@/lib/lane/reap-sessions', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/lane/reap-sessions')>(),
  killLaneSessionsConfirmed: h.kill,
}));

describe('lane stop command', () => {
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
});
