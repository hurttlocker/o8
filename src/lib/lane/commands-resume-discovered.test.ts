import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLane, getLane, updateLane } from '@/lib/lane/registry';
import { dispatch } from './commands';

const h = vi.hoisted(() => ({
  launch: vi.fn(),
  steer: vi.fn(),
}));

vi.mock('@/lib/runtime/actions', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtime/actions')>(),
  launchRuntimeSurface: h.launch,
  performRuntimeAction: h.steer,
}));

describe('lane resume with an external CLI session', () => {
  afterEach(() => {
    h.launch.mockReset();
    h.steer.mockReset();
  });

  it.each([
    ['codex', 'codex:discovered-thread', undefined],
    ['codex', 'codex-discovered:discovered-thread', undefined],
    ['codex', 'codex-live:12345', 'Continue the work'],
    ['claude-code', 'claude-code:discovered-thread', undefined],
    ['claude-code', 'claude-code-discovered:discovered-thread', undefined],
    ['claude-code', 'claude-code:live-12345', 'Continue the work'],
  ] as const)('refuses %s %s without replacing the original session', async (runtime, sessionKey, message) => {
    const lane = createLane({
      repoPath: process.cwd(),
      branch: `test/discovered-resume-${runtime}-${sessionKey.replaceAll(':', '-')}`,
      runtime,
      sessionKey,
    });
    updateLane(lane.id, { status: 'awaiting_input' }, 'system');
    const before = getLane(lane.id);

    const result = await dispatch({ verb: 'resume', laneId: lane.id, message, actor: 'user' });

    expect(result).toMatchObject({ ok: false, reason: 'cli_resume_requires_explicit_action' });
    expect(result.note).toContain('original terminal');
    expect(getLane(lane.id)).toMatchObject({
      sessionKey,
      status: before?.status,
      lastEventLabel: before?.lastEventLabel,
    });
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.steer).not.toHaveBeenCalled();
  });
});
