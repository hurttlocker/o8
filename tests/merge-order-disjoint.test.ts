/**
 * #1525 — parallel packets with disjoint diffs must merge in ANY order.
 *
 * approveAndMergePacket used to force every earlier-positioned same-wave
 * packet to merge before the requested one — but the recommended order is a
 * SIZE heuristic (bigger diffs first), not a dependency. A 2-packet parallel
 * mission with no shared files refused "inline-1 before inline-2" for no
 * stated reason. Ordering is only real between packets whose diffs overlap.
 */
import { describe, expect, it } from 'vitest';

import { selectMergeSequence } from '@/lib/orchestrator/operator-mission-service/merge';

function candidate(id: string, overlapping: string[] = []) {
  return {
    worktree: { id },
    overlappingWorktreeIds: new Set(overlapping),
    packet: { id: `pkt-${id}` },
  };
}

describe('#1525 — merge order is only enforced between overlapping packets', () => {
  it('a disjoint later-positioned packet merges alone — no forced prerequisites', () => {
    const ordered = [candidate('wt-big'), candidate('wt-small')];
    const sequence = selectMergeSequence(ordered, 1);
    expect(sequence.map((entry) => entry.worktree.id)).toEqual(['wt-small']);
  });

  it('an overlapping earlier packet IS a prerequisite', () => {
    const ordered = [
      candidate('wt-big', ['wt-small']),
      candidate('wt-small', ['wt-big']),
    ];
    const sequence = selectMergeSequence(ordered, 1);
    expect(sequence.map((entry) => entry.worktree.id)).toEqual(['wt-big', 'wt-small']);
  });

  it('mixed wave: only the overlapping sibling is pulled in, disjoint ones are skipped', () => {
    const ordered = [
      candidate('wt-a'),
      candidate('wt-b', ['wt-target']),
      candidate('wt-c'),
      candidate('wt-target', ['wt-b']),
    ];
    const sequence = selectMergeSequence(ordered, 3);
    expect(sequence.map((entry) => entry.worktree.id)).toEqual(['wt-b', 'wt-target']);
  });

  it('requesting the first-positioned packet never has prerequisites', () => {
    const ordered = [candidate('wt-big', ['wt-small']), candidate('wt-small', ['wt-big'])];
    const sequence = selectMergeSequence(ordered, 0);
    expect(sequence.map((entry) => entry.worktree.id)).toEqual(['wt-big']);
  });
});
