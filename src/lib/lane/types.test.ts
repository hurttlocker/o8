import { describe, expect, it } from 'vitest';

import { isTerminalRuntimeStatus } from '@/lib/orchestrator/runtime-status';

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

describe('isTerminalRuntimeStatus', () => {
  it('treats poller-facing completion labels as terminal', () => {
    expect(isTerminalRuntimeStatus('reviewing')).toBe(true);
    expect(isTerminalRuntimeStatus('failed')).toBe(true);
    expect(isTerminalRuntimeStatus('released')).toBe(true);
    expect(isTerminalRuntimeStatus('archived')).toBe(true);
    expect(isTerminalRuntimeStatus('silent_exit_no_work')).toBe(true);
    expect(isTerminalRuntimeStatus('silent_exit_work_present')).toBe(true);
    expect(isTerminalRuntimeStatus('silent_exit_already_merged')).toBe(true);
  });

  it('rejects active and unrelated poller-facing labels', () => {
    expect(isTerminalRuntimeStatus(null)).toBe(false);
    expect(isTerminalRuntimeStatus(undefined)).toBe(false);
    expect(isTerminalRuntimeStatus('')).toBe(false);
    expect(isTerminalRuntimeStatus('running')).toBe(false);
    expect(isTerminalRuntimeStatus('session_lost')).toBe(false);
    expect(isTerminalRuntimeStatus('silent')).toBe(false);
  });
});
