/**
 * Pipeline root-fix contracts (2026-07-03) — the two predicates that buried
 * review-ready work. These sets ARE the policy; pin them so a future edit
 * that re-adds `reviewing` to the probe set or `silent_exit_work_present` to
 * the terminally-dead set fails loudly with this incident's context.
 */
import { describe, expect, it } from 'vitest';

import { DEAD_LANE_EVENT_LABELS, INTERESTING_LANE_STATUSES } from './silent-exit-detector';

describe('silent-exit detector policy (wave-1B burial incident)', () => {
  it('never probes reviewing lanes — a dead process after completion is normal, not a silent exit', () => {
    expect(INTERESTING_LANE_STATUSES.has('reviewing')).toBe(false);
    expect(INTERESTING_LANE_STATUSES.has('running')).toBe(true);
    expect(INTERESTING_LANE_STATUSES.has('awaiting_input')).toBe(true);
  });

  it('never auto-archives work-present lanes — committed work is review-ready, not terminally dead', () => {
    expect(DEAD_LANE_EVENT_LABELS.has('silent_exit_work_present')).toBe(false);
    expect(DEAD_LANE_EVENT_LABELS.has('silent_exit_no_work')).toBe(true);
    expect(DEAD_LANE_EVENT_LABELS.has('zombie_reap')).toBe(true);
  });
});
