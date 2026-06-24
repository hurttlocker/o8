import { describe, it, expect } from 'vitest';
import { isRetiredLaneStatus, RETIRED_LANE_STATUSES } from './useLaneArchivedSet';

// #1293 — the pure decision behind closing an orphaned workspace tab when its
// lane retires. The listener in useWorkspaceTerminal gates on this; a wrong
// answer either leaves a zombie tab (false-negative) or closes a live tab
// mid-flight (false-positive), so pin it.
describe('isRetiredLaneStatus (#1293 close-orphan-tab decision)', () => {
  it('true for retired statuses (worker has exited)', () => {
    expect(isRetiredLaneStatus('archived')).toBe(true);
    expect(isRetiredLaneStatus('completed')).toBe(true);
  });

  it('false for active statuses — never close a live tab', () => {
    for (const s of ['running', 'awaiting_review', 'launching', 'recovering', 'merging', 'blocked']) {
      expect(isRetiredLaneStatus(s)).toBe(false);
    }
  });

  it('false for missing/empty status', () => {
    expect(isRetiredLaneStatus(undefined)).toBe(false);
    expect(isRetiredLaneStatus(null)).toBe(false);
    expect(isRetiredLaneStatus('')).toBe(false);
  });

  it('RETIRED_LANE_STATUSES is the single source of truth', () => {
    expect([...RETIRED_LANE_STATUSES].sort()).toEqual(['archived', 'completed']);
  });
});
