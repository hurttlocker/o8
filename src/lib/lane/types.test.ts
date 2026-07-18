import { describe, expect, it } from 'vitest';

import { isTerminalLaneStatus, LANE_STATUSES, type LaneStatus } from './types';

const EXPECTED_TERMINAL_STATUSES = [
  'reviewing',
  'failed',
  'completed',
  'archived',
] as const satisfies readonly LaneStatus[];
const EXPECTED_TERMINAL_STATUS_SET = new Set<LaneStatus>(EXPECTED_TERMINAL_STATUSES);

describe('isTerminalLaneStatus', () => {
  it('classifies every runtime lane status explicitly', () => {
    const expected = new Map<LaneStatus, boolean>(
      LANE_STATUSES.map((status) => [status, EXPECTED_TERMINAL_STATUS_SET.has(status)]),
    );

    expect(Object.fromEntries(LANE_STATUSES.map((status) => [status, isTerminalLaneStatus(status)]))).toEqual(
      Object.fromEntries(expected),
    );
  });

  it('rejects empty and non-terminal lane statuses', () => {
    expect(isTerminalLaneStatus(null)).toBe(false);
    expect(isTerminalLaneStatus(undefined)).toBe(false);
    expect(isTerminalLaneStatus('idle')).toBe(false);
    expect(isTerminalLaneStatus('running')).toBe(false);
  });
});

