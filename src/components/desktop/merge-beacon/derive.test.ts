import { describe, it, expect } from 'vitest';
import { deriveParkedLanes } from './derive';
import type { DomainLaneSummary } from '@/lib/orchestrator/store';

function lane(
  partial: Partial<DomainLaneSummary> & { laneId: string; status: string },
): DomainLaneSummary {
  return {
    packetId: `p-${partial.laneId}`,
    sessionKey: null,
    lastEventLabel: null,
    ...partial,
  };
}

describe('deriveParkedLanes', () => {
  it('returns empty for no lanes', () => {
    expect(deriveParkedLanes([])).toEqual([]);
  });

  it('keeps only parked statuses (reviewing + awaiting_*), drops in-motion + terminal', () => {
    const lanes = [
      lane({ laneId: 'a', status: 'reviewing' }),
      lane({ laneId: 'b', status: 'running' }),
      lane({ laneId: 'c', status: 'awaiting_orchestrator' }),
      lane({ laneId: 'd', status: 'awaiting_human' }),
      lane({ laneId: 'e', status: 'merging' }),
      lane({ laneId: 'f', status: 'completed' }),
      lane({ laneId: 'g', status: 'launching' }),
    ];
    expect(deriveParkedLanes(lanes).map((p) => p.laneId)).toEqual(['a', 'c', 'd']);
  });

  it('carries branch/repoPath/label through for the popover + click', () => {
    const parked = deriveParkedLanes([
      lane({ laneId: 'a', status: 'reviewing', branch: 'feat/x', repoPath: '/r', label: 'Fix x' }),
    ]);
    expect(parked[0]).toMatchObject({ branch: 'feat/x', repoPath: '/r', label: 'Fix x' });
  });

  it('excludes a lane whose PACKET is closed even if the lane status is stale-stuck at reviewing (the "1 ready" bug)', () => {
    const lanes = [
      lane({ laneId: 'merged', status: 'reviewing', packetId: 'pkt-merged' }), // packet merged+archived, lane status lagged
      lane({ laneId: 'live', status: 'reviewing', packetId: 'pkt-live' }),     // genuinely still parked
    ];
    const closed = new Set(['pkt-merged']);
    const parked = deriveParkedLanes(lanes, closed);
    expect(parked.map((p) => p.laneId)).toEqual(['live']); // the merged one dropped
  });

  it('with no closed set, behaves exactly as before (parity)', () => {
    const lanes = [lane({ laneId: 'a', status: 'reviewing' })];
    expect(deriveParkedLanes(lanes).map((p) => p.laneId)).toEqual(['a']);
    expect(deriveParkedLanes(lanes, new Set()).map((p) => p.laneId)).toEqual(['a']);
  });
});
