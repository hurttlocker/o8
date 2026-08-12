import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMissionReceipt } from './useTurnSummaryReceipt';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchMissionReceipt', () => {
  it('unwraps the operator API envelope and carries cost plus funnel truth', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      result: {
        cost: { totalCostUsd: 0.0123 },
        funnel: {
          totalDurationMs: 62_000,
          terminalPacketCount: 1,
          packets: [{ packetId: 'packet-one' }],
          attemptCount: 2,
          retryCount: 1,
          interventionCount: 1,
          recoveryEventCount: 0,
          strictAutonomousCloseCount: 0,
          governedAutonomousCloseCount: 0,
        },
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchMissionReceipt('mission one', true)).resolves.toEqual({
      costUsd: 0.0123,
      funnel: {
        totalDurationMs: 62_000,
        terminalPacketCount: 1,
        packetCount: 1,
        attemptCount: 2,
        retryCount: 1,
        interventionCount: 1,
        recoveryEventCount: 0,
        strictAutonomousCloseCount: 0,
        governedAutonomousCloseCount: 0,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/orchestrator/status?missionId=mission%20one&includeCost=true&includeTiming=true',
      { cache: 'no-store' },
    );
  });
});
