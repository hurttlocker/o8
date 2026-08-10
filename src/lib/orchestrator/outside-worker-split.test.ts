import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claimOutsideWorkerSplits,
  outsideWorkerSessionKeysForLane,
  outsideWorkerSessionKeysForPacketIds,
  outsideWorkerSessionKeysForSettledPackets,
  queueOutsideWorkerSplit,
  resetOutsideWorkerSplitsForTest,
  subscribeOutsideWorkerSplits,
} from './outside-worker-split';

afterEach(() => resetOutsideWorkerSplitsForTest());

describe('outside worker split broker', () => {
  it('holds a launch until an active chat surface claims it', () => {
    queueOutsideWorkerSplit({
      sessionKey: 'opencode-owned:one',
      runtime: 'opencode',
      repoPath: '/tmp/example',
    });

    expect(claimOutsideWorkerSplits('orchestrator-one')).toEqual([
      expect.objectContaining({ sessionKey: 'opencode-owned:one' }),
    ]);
    expect(claimOutsideWorkerSplits('orchestrator-one')).toEqual([]);
    expect(claimOutsideWorkerSplits('orchestrator-two')).toEqual([]);
  });

  it('updates a queued launch without duplicating its split', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOutsideWorkerSplits(listener);
    queueOutsideWorkerSplit({ sessionKey: 'codex-owned:one', runtime: 'codex', repoPath: '/tmp/one' });
    queueOutsideWorkerSplit({ sessionKey: 'codex-owned:one', runtime: 'codex', repoPath: '/tmp/two' });

    expect(claimOutsideWorkerSplits('orchestrator-one')).toEqual([
      expect.objectContaining({ sessionKey: 'codex-owned:one', repoPath: '/tmp/two' }),
    ]);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it('keeps the lane binding after claim so terminal events can retire the pane', () => {
    queueOutsideWorkerSplit({
      sessionKey: 'opencode-owned:outside',
      runtime: 'opencode',
      repoPath: '/tmp/outside',
      laneId: 'lane-outside',
    });

    claimOutsideWorkerSplits('orchestrator-tab');

    expect(outsideWorkerSessionKeysForLane('lane-outside')).toEqual(['opencode-owned:outside']);
  });

  it('keeps the packet binding after its lane is released from durable state', () => {
    queueOutsideWorkerSplit({
      sessionKey: 'opencode-owned:released',
      runtime: 'opencode',
      repoPath: '/tmp/outside',
      packetId: 'packet-released',
      laneId: 'lane-gone',
    });

    claimOutsideWorkerSplits('orchestrator-tab');

    expect(outsideWorkerSessionKeysForPacketIds(new Set(['packet-released']))).toEqual([
      'opencode-owned:released',
    ]);
    expect(outsideWorkerSessionKeysForSettledPackets([{
      id: 'packet-released',
      status: 'released',
      releaseState: 'released',
      archivedAt: null,
    }])).toEqual(['opencode-owned:released']);
  });
});
