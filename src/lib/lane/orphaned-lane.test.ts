import os from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getLane: vi.fn(),
  archiveLane: vi.fn(),
  updateLane: vi.fn(),
}));

vi.mock('./registry', () => ({
  getLane: mocks.getLane,
  archiveLane: mocks.archiveLane,
  updateLane: mocks.updateLane,
}));

import {
  ORPHANED_WORKTREE_EVENT_LABEL,
  laneWorktreeIsMissing,
  markLaneWorktreeOrphaned,
  orphanedDiscardRefusal,
} from './orphaned-lane';

const GONE = join(os.tmpdir(), 'o8-2144-checkout-that-was-removed');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('laneWorktreeIsMissing', () => {
  it('is true for a recorded path that is gone', () => {
    expect(laneWorktreeIsMissing({ worktreePath: GONE })).toBe(true);
  });

  it('is false for a path that still exists', () => {
    expect(laneWorktreeIsMissing({ worktreePath: os.tmpdir() })).toBe(false);
  });

  it('is false when the lane never recorded a path — absence is not proof of loss', () => {
    expect(laneWorktreeIsMissing({ worktreePath: null })).toBe(false);
    expect(laneWorktreeIsMissing({ worktreePath: '   ' })).toBe(false);
  });
});

describe('orphanedDiscardRefusal', () => {
  it('allows an escalated lane whose checkout is gone', () => {
    expect(orphanedDiscardRefusal({ id: 'l1', status: 'awaiting_human', worktreePath: GONE }, true)).toBeNull();
    expect(orphanedDiscardRefusal({ id: 'l2', status: 'awaiting_orchestrator', worktreePath: GONE }, true)).toBeNull();
  });

  it('refuses while the work is still on disk', () => {
    expect(orphanedDiscardRefusal({ id: 'l3', status: 'reviewing', worktreePath: '/somewhere' }, false))
      .toMatchObject({ code: 'worktree_present' });
  });

  it('refuses a lane whose lifecycle is already over', () => {
    for (const status of ['failed', 'completed', 'archived'] as const) {
      expect(orphanedDiscardRefusal({ id: 'l4', status, worktreePath: GONE }, true))
        .toMatchObject({ code: 'already_terminal' });
    }
  });

  it('refuses a lane that is not in the registry', () => {
    expect(orphanedDiscardRefusal(null, true)).toMatchObject({ code: 'lane_not_found' });
  });
});

describe('markLaneWorktreeOrphaned', () => {
  it('stamps a still-open lane without moving its status', () => {
    mocks.getLane.mockReturnValue({ id: 'l5', status: 'awaiting_human', worktreePath: GONE });
    mocks.updateLane.mockReturnValue({ id: 'l5', status: 'awaiting_human' });

    markLaneWorktreeOrphaned('l5');

    expect(mocks.updateLane).toHaveBeenCalledWith(
      'l5',
      expect.objectContaining({ lastEventLabel: ORPHANED_WORKTREE_EVENT_LABEL }),
      'system',
      expect.objectContaining({ eventLabel: ORPHANED_WORKTREE_EVENT_LABEL }),
    );
    // The escalation is still owned by a human — marking must never end it.
    expect(mocks.updateLane.mock.calls[0]?.[1]).not.toHaveProperty('status');
  });

  it('leaves a lane whose lifecycle is over alone', () => {
    mocks.getLane.mockReturnValue({ id: 'l6', status: 'completed', worktreePath: GONE });

    expect(markLaneWorktreeOrphaned('l6')).toBeNull();
    expect(mocks.updateLane).not.toHaveBeenCalled();
  });
});
