import { describe, expect, it } from 'vitest';

import { createLane, getLane, setLaneStatus } from './registry';
import { TERMINAL_LANE_STATUSES, isRefusedTerminalTransition } from './terminal-states';
import { dispatch } from './commands';

function laneFixture(branch: string) {
  return createLane({
    repoPath: '/tmp/o8-terminal-state-test-repo',
    branch,
    baseBranch: 'main',
    runtime: 'codex',
  });
}

describe('isRefusedTerminalTransition', () => {
  it('refuses re-opening a terminal lane (the #531 supervisor race)', () => {
    expect(isRefusedTerminalTransition('completed', 'awaiting_input')).toBe(true);
    expect(isRefusedTerminalTransition('completed', 'running')).toBe(true);
    expect(isRefusedTerminalTransition('failed', 'running')).toBe(true);
    expect(isRefusedTerminalTransition('archived', 'running')).toBe(true);
  });

  it('allows archiving from any terminal state', () => {
    expect(isRefusedTerminalTransition('completed', 'archived')).toBe(false);
    expect(isRefusedTerminalTransition('failed', 'archived')).toBe(false);
    expect(isRefusedTerminalTransition('archived', 'archived')).toBe(false);
  });

  it('allows idempotent same-status writes', () => {
    expect(isRefusedTerminalTransition('completed', 'completed')).toBe(false);
    expect(isRefusedTerminalTransition('failed', 'failed')).toBe(false);
  });

  it('never refuses transitions from non-terminal states', () => {
    expect(isRefusedTerminalTransition('running', 'completed')).toBe(false);
    expect(isRefusedTerminalTransition('awaiting_input', 'failed')).toBe(false);
    expect(isRefusedTerminalTransition('merging', 'running')).toBe(false);
  });

  it('terminal set stays exactly failed/completed/archived', () => {
    expect([...TERMINAL_LANE_STATUSES].sort()).toEqual(['archived', 'completed', 'failed']);
  });
});

describe('terminal lane status guard - real callers', () => {
  it('refuses direct registry re-open writes after completion', () => {
    const lane = laneFixture('inline/terminal-registry');
    setLaneStatus(lane.id, 'completed', 'system', 'merged');

    const attempted = setLaneStatus(lane.id, 'reviewing', 'system', 'merge_error');

    expect(attempted?.status).toBe('completed');
    expect(attempted?.lastEventLabel).toBe('merged');
    expect(getLane(lane.id)?.status).toBe('completed');
  });

  it('refuses merge command fallback paths that try to re-open a completed lane', async () => {
    const lane = laneFixture('inline/terminal-merge-command');
    setLaneStatus(lane.id, 'completed', 'system', 'merged');

    const result = await dispatch({
      verb: 'merge',
      laneId: lane.id,
      actor: 'user',
    });

    expect(result.ok).toBe(false);
    expect(result.note).toMatch(/No worktree to merge/);
    expect(getLane(lane.id)?.status).toBe('completed');
    expect(getLane(lane.id)?.lastEventLabel).toBe('merged');
  }, 20_000);

  it('allows archive as the only terminal successor through the command bus', async () => {
    const lane = laneFixture('inline/terminal-archive-command');
    setLaneStatus(lane.id, 'completed', 'system', 'merged');

    const result = await dispatch({
      verb: 'archive',
      laneId: lane.id,
      actor: 'user',
    });

    expect(result.ok).toBe(true);
    expect(getLane(lane.id)?.status).toBe('archived');
  }, 20_000);
});
