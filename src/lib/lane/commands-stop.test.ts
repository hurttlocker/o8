import { describe, expect, it, vi } from 'vitest';
import { createLane, getLaneEvents } from '@/lib/lane/registry';
import { dispatch } from './commands';

vi.mock('@/lib/runtime/actions', () => ({
  performRuntimeAction: vi.fn(async () => ({
    ok: false,
    action: 'stop',
    surfaceId: 'codex-owned:stubborn',
    runtime: 'codex',
    status: 'unavailable',
    note: 'Worker remained live after SIGINT, SIGTERM, and SIGKILL.',
  })),
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
      packetId: 'pkt-stop-command-test',
      actor: 'system',
    });
    await dispatch({ verb: 'attach_session', laneId: lane.id, sessionKey: 'codex-owned:stubborn' });

    const result = await dispatch({ verb: 'stop', laneId: lane.id, actor: 'user' });

    expect(result.ok).toBe(false);
    expect(result.lane?.status).toBe('running');
    expect(result.lane?.lastEventLabel).toBe('interrupt_failed');
    expect(getLaneEvents(lane.id).some((event) => event.verb === 'interrupt_failed')).toBe(true);
  });
});
