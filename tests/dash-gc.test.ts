import { describe, expect, it } from 'vitest';

import { selectOrphanDashSessions, type DashSessionInfo } from '@/lib/terminal/dash-gc';

/**
 * #6 persistent terminals — orphan dash-session GC policy.
 *
 * The pure decision behind `reapOrphanDashSessions` in ws-server: given the live
 * `cortex-dash-*` tmux sessions + the durable reference set (persisted tabs +
 * live-client sessions), which are safe to kill. The ws-server side does the
 * tmux I/O; this proves the policy never reaps a survivor and bounds the leak.
 */
describe('#6 dash-session GC policy', () => {
  const NOW = 10_000_000;
  const MIN_AGE = 5 * 60 * 1000;
  const old = (name: string): DashSessionInfo => ({ name, createdMs: NOW - MIN_AGE - 1 });
  const young = (name: string): DashSessionInfo => ({ name, createdMs: NOW - 1000 });
  const opts = { nowMs: NOW, minAgeMs: MIN_AGE, maxSessions: 64 };

  it('reaps an unreferenced session past the min-age window', () => {
    const kill = selectOrphanDashSessions([old('cortex-dash-a')], new Set(), opts);
    expect(kill).toEqual(['cortex-dash-a']);
  });

  it('keeps a referenced session even when old (persisted tab still owns it)', () => {
    const kill = selectOrphanDashSessions(
      [old('cortex-dash-a'), old('cortex-dash-b')],
      new Set(['cortex-dash-b']),
      opts,
    );
    expect(kill).toEqual(['cortex-dash-a']);
  });

  it('spares a young unreferenced session (create→persist race guard)', () => {
    const kill = selectOrphanDashSessions([young('cortex-dash-fresh')], new Set(), opts);
    expect(kill).toEqual([]);
  });

  it('returns nothing when there are no sessions', () => {
    expect(selectOrphanDashSessions([], new Set(['cortex-dash-x']), opts)).toEqual([]);
  });

  it('over the hard cap, reaps the OLDEST unreferenced beyond the cap and never a referenced one', () => {
    // 4 sessions, cap 2. Two are referenced (must survive). The two unreferenced
    // are both young (min-age would spare them) but the cap forces overflow reap
    // of the oldest unreferenced until survivors == cap.
    const sessions: DashSessionInfo[] = [
      { name: 'ref-old', createdMs: NOW - 100 },
      { name: 'ref-new', createdMs: NOW - 50 },
      { name: 'orphan-older', createdMs: NOW - 80 },
      { name: 'orphan-newer', createdMs: NOW - 10 },
    ];
    const referenced = new Set(['ref-old', 'ref-new']);
    const kill = selectOrphanDashSessions(sessions, referenced, { ...opts, maxSessions: 2 });
    // 4 sessions, cap 2 → must drop 2. Both orphans are unreferenced → both go,
    // oldest first; the two referenced survive.
    expect(kill.sort()).toEqual(['orphan-newer', 'orphan-older']);
    expect(kill).not.toContain('ref-old');
    expect(kill).not.toContain('ref-new');
  });

  it('cap never kills a referenced session even when referenced count exceeds the cap', () => {
    const sessions: DashSessionInfo[] = [
      { name: 'ref-1', createdMs: NOW - 100 },
      { name: 'ref-2', createdMs: NOW - 90 },
      { name: 'ref-3', createdMs: NOW - 80 },
    ];
    const referenced = new Set(['ref-1', 'ref-2', 'ref-3']);
    const kill = selectOrphanDashSessions(sessions, referenced, { ...opts, maxSessions: 1 });
    expect(kill).toEqual([]);
  });
});
