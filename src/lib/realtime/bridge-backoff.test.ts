import { describe, expect, it } from 'vitest';
import {
  canAttemptRealtimeBridge,
  createRealtimeBridgeBackoffState,
  recordRealtimeBridgeFailure,
  recordRealtimeBridgeSuccess,
} from './bridge-backoff';

describe('realtime bridge backoff', () => {
  it('waits until the threshold before marking the bridge down', () => {
    const state = createRealtimeBridgeBackoffState();
    for (let i = 0; i < 4; i += 1) {
      expect(recordRealtimeBridgeFailure(state, 1_000, { threshold: 5 }).transition).toBeNull();
    }
    const result = recordRealtimeBridgeFailure(state, 1_000, { threshold: 5, initialDelayMs: 500 });
    expect(result.transition).toBe('down');
    expect(result.delayMs).toBe(500);
    expect(canAttemptRealtimeBridge(state, 1_200)).toBe(false);
  });

  it('widens retry intervals and caps them', () => {
    const state = createRealtimeBridgeBackoffState();
    const delays: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      delays.push(recordRealtimeBridgeFailure(state, 1_000, {
        threshold: 2,
        initialDelayMs: 1_000,
        maxDelayMs: 4_000,
      }).delayMs);
    }
    expect(delays.slice(1)).toEqual([1_000, 2_000, 4_000, 4_000, 4_000, 4_000, 4_000]);
  });

  it('resets on success and reports an up transition once', () => {
    const state = createRealtimeBridgeBackoffState();
    recordRealtimeBridgeFailure(state, 1_000, { threshold: 1 });
    expect(recordRealtimeBridgeSuccess(state).transition).toBe('up');
    expect(recordRealtimeBridgeSuccess(state).transition).toBeNull();
    expect(state.failureCount).toBe(0);
    expect(canAttemptRealtimeBridge(state, 1_000)).toBe(true);
  });
});
