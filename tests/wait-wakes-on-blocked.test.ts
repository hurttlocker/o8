/**
 * #1467 — wait_for_mission_ready must wake on `blocked` packets.
 *
 * `blocked` is what awaiting_input (silent-exit parks), awaiting_orchestrator
 * (huddle, #1495), awaiting_human, and dispatch failures map to — none of them
 * progress without a decision. The old terminal set excluded `blocked`, so an
 * orchestrator sitting in wait_for_mission_ready slept through its own
 * worker's huddle until the 10-minute timeout: a mutual wait deadlock.
 *
 * Drives the REAL handler with a mocked mission-status read (a packet already
 * `blocked` at baseline — the case the signature-change wake cannot catch).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/mcp/operator-mission-tools', () => ({
  createMission: vi.fn(),
  createMissionInline: vi.fn(),
  dispatchMission: vi.fn(),
  getMissionStatus: vi.fn(async () => ({
    packets: [
      { id: 'pkt-running', status: 'running', releaseState: 'pending' },
      { id: 'pkt-huddled', status: 'blocked', releaseState: 'pending' },
    ],
  })),
  rerunWithFeedback: vi.fn(),
  resetPacket: vi.fn(),
  submitPacketReview: vi.fn(),
}));

const { handleWaitForMissionReady } = await import('@/lib/mcp/operator-handlers/mission');

function parsePayload(result: { content?: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const text = result.content?.find((block) => block.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

describe('#1467 — wait_for_mission_ready wakes on blocked packets', () => {
  it('returns immediately when a packet is already blocked at baseline', async () => {
    const started = Date.now();
    const result = await handleWaitForMissionReady({ timeoutMs: 2_000, pollIntervalMs: 1_000 });
    const payload = parsePayload(result as { content?: Array<{ type: string; text?: string }> });

    expect(payload.wakeReason).toBe('already-terminal');
    expect(payload.terminalPacketId).toBe('pkt-huddled');
    // The old set slept to the timeout; the fix answers on the first read.
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('long-polls a rerun-in-progress packet while its lane is running', async () => {
    const readStatus = vi.fn(async () => ({
      packets: [{
        id: 'pkt-rerun',
        status: 'blocked',
        releaseState: 'pending',
        blockedReason: 'rerun_in_progress',
        lane: { status: 'running' },
      }],
    }));

    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = handleWaitForMissionReady(
        { packetId: 'pkt-rerun', timeoutMs: 1_000, pollIntervalMs: 1_000 },
        readStatus,
      ).then((result) => {
        settled = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      expect(readStatus).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      const payload = parsePayload(result as { content?: Array<{ type: string; text?: string }> });
      expect(payload.wakeReason).toBe('timeout');
      expect(payload.wakeReason).not.toBe('already-terminal');
      expect(readStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns immediately when a reviewing lane is already awaiting review', async () => {
    const readStatus = vi.fn(async () => ({
      packets: [{
        id: 'pkt-review',
        status: 'awaiting_review',
        releaseState: 'pending',
        lane: { status: 'reviewing' },
      }],
    }));

    const result = await handleWaitForMissionReady(
      { packetId: 'pkt-review', timeoutMs: 2_000, pollIntervalMs: 1_000 },
      readStatus,
    );
    const payload = parsePayload(result as { content?: Array<{ type: string; text?: string }> });

    expect(payload.wakeReason).toBe('already-terminal');
    expect(payload.terminalPacketId).toBe('pkt-review');
    expect(readStatus).toHaveBeenCalledTimes(1);
  });
});
