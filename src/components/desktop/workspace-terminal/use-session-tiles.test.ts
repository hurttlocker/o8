import { describe, expect, it } from 'vitest';
import {
  addSessionToLayout,
  closeSessionLeaf,
  collectSessionLeaves,
  createDefaultSessionTileLayout,
  reconcileSessionTileParticipants,
} from '@/lib/orchestrator/session-tiles';
import { resolveFocusedSessionKey } from './use-session-tiles';

describe('useSessionTiles focus and rotation seam', () => {
  it('keeps a non-first focused leaf through rotation and ignores retirement of the old transport', () => {
    let layout = addSessionToLayout(createDefaultSessionTileLayout(), 'session:first');
    layout = addSessionToLayout(layout, 'session:old');
    layout = reconcileSessionTileParticipants(layout, [{
      participantId: 'packet:stable',
      packetId: 'packet:stable',
      laneId: 'lane:stable',
      sessionKey: 'session:old',
    }]);
    const focusedLeaf = collectSessionLeaves(layout.root)
      .find((leaf) => leaf.participantId === 'packet:stable');
    expect(focusedLeaf).toBeTruthy();
    if (!focusedLeaf) return;

    const rotated = reconcileSessionTileParticipants(layout, [{
      participantId: 'packet:stable',
      packetId: 'packet:stable',
      laneId: 'lane:stable',
      sessionKey: 'session:new',
    }]);
    const staleLeaf = collectSessionLeaves(rotated.root)
      .find((leaf) => leaf.sessionKey === 'session:old');
    const afterRetireOld = staleLeaf ? closeSessionLeaf(rotated, staleLeaf.id) : rotated;
    const retained = collectSessionLeaves(afterRetireOld.root)
      .find((leaf) => leaf.participantId === 'packet:stable');

    expect(retained).toMatchObject({
      id: focusedLeaf.id,
      arrivalOrder: focusedLeaf.arrivalOrder,
      sessionKey: 'session:new',
    });
    expect(resolveFocusedSessionKey(
      collectSessionLeaves(afterRetireOld.root),
      focusedLeaf.id,
    )).toBe('session:new');
  });
});
