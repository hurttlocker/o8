import { describe, expect, it } from 'vitest';
import { workerPaneTabMatchesLane } from './useDedicatedWorkerPane';

describe('worker pane lane identity', () => {
  it('reuses a pane when a retry changes the session but keeps the lane', () => {
    expect(workerPaneTabMatchesLane(
      { sessionKey: 'old-session', laneId: 'lane-1', packetId: 'packet-1' },
      { sessionKey: 'new-session', laneId: 'lane-1', packetId: 'packet-1' },
    )).toBe(true);
  });

  it('reuses a pane when only the packet identity survives', () => {
    expect(workerPaneTabMatchesLane(
      { sessionKey: 'old-session', packetId: 'packet-1' },
      { sessionKey: 'new-session', packetId: 'packet-1' },
    )).toBe(true);
  });

  it('does not collapse distinct workers from the same repo', () => {
    expect(workerPaneTabMatchesLane(
      { sessionKey: 'session-1', laneId: 'lane-1', packetId: 'packet-1' },
      { sessionKey: 'session-2', laneId: 'lane-2', packetId: 'packet-2' },
    )).toBe(false);
  });
});
