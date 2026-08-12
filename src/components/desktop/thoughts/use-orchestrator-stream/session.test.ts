import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshOrchestratorTokenTelemetry } from './session';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('orchestrator context telemetry', () => {
  it('feeds parent-only context tokens to the auto-compact counter while preserving rolled-up cost', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        agents: [{
          runtime: 'claude-code',
          sessionKey: 'claude-code:parent',
          sessionKind: 'owned',
          status: 'idle',
          isCurrentSession: true,
          workspace: '/repo',
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        telemetry: {
          totalTokens: 50_000,
          contextTokens: 5_000,
          estimatedCostUsd: 0.42,
          model: 'claude-sonnet-5',
        },
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const runningTotals: number[] = [];
    const turnDeltas: number[] = [];

    const result = await refreshOrchestratorTokenTelemetry({
      repoPath: '/repo',
      setRunningTotal: (value) => runningTotals.push(value),
      setTokenCount: (value) => turnDeltas.push(value),
      telemetrySessionKeyRef: { current: null },
      telemetryTotalRef: { current: null },
    });

    expect(result).toEqual({
      totalTokens: 5_000,
      estimatedCostUsd: 0.42,
      model: 'claude-sonnet-5',
    });
    expect(runningTotals).toEqual([5_000]);
    expect(turnDeltas).toEqual([0]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
