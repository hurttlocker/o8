import { describe, expect, it } from 'vitest';

import { isTerminalStatus, LANE_STATUSES, type LaneStatus } from './types';

const EXPECTED_TERMINAL_STATUSES = [
  'reviewing',
  'failed',
  'completed',
  'archived',
] as const satisfies readonly LaneStatus[];

describe('isTerminalStatus', () => {
  it('classifies every runtime lane status explicitly', () => {
    const expected = new Map<LaneStatus, boolean>(
      LANE_STATUSES.map((status) => [status, EXPECTED_TERMINAL_STATUSES.includes(status)]),
    );

    expect(Object.fromEntries(LANE_STATUSES.map((status) => [status, isTerminalStatus(status)]))).toEqual(
      Object.fromEntries(expected),
    );
  });

  it('treats every silent-exit event label as terminal', () => {
    expect(isTerminalStatus('silent_exit_no_work')).toBe(true);
    expect(isTerminalStatus('silent_exit_work_present')).toBe(true);
    expect(isTerminalStatus('silent_exit_already_merged')).toBe(true);
  });

  it('rejects empty and non-terminal labels', () => {
    expect(isTerminalStatus(null)).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
    expect(isTerminalStatus('')).toBe(false);
    expect(isTerminalStatus('session_lost')).toBe(false);
    expect(isTerminalStatus('silent')).toBe(false);
  });
});
