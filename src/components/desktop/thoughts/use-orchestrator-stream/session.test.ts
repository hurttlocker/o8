import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshOrchestratorTokenTelemetry } from './session';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('orchestrator context telemetry', () => {
  it('feeds parent-only context tokens to the auto-compact counter while preserving rolled-up cost', async () => {
    const fetchMock = vi.fn()
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
      threadId: 'thoughts-current',
      backend: 'claude',
      setRunningTotal: (value) => runningTotals.push(value),
      setTokenCount: (value) => turnDeltas.push(value),
      telemetryBindingRef: { current: null },
      telemetryTotalRef: { current: null },
    });

    expect(result).toEqual({
      totalTokens: 5_000,
      estimatedCostUsd: 0.42,
      model: 'claude-sonnet-5',
    });
    expect(runningTotals).toEqual([5_000]);
    expect(turnDeltas).toEqual([0]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/runtime/telemetry?threadId=thoughts-current&backend=claude',
      { cache: 'no-store' },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never falls back to a same-repo provider session for an unbound fresh thread', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshOrchestratorTokenTelemetry({
      repoPath: '/repo',
      threadId: 'thoughts-fresh',
      backend: null,
      setRunningTotal: vi.fn(),
      setTokenCount: vi.fn(),
      telemetryBindingRef: { current: 'thoughts-old\0claude' },
      telemetryTotalRef: { current: 151_000 },
    });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resets the token baseline when the same UI thread switches providers', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ telemetry: { contextTokens: 90_000 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ telemetry: { contextTokens: 4_000 } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const bindingRef = { current: null as string | null };
    const totalRef = { current: null as number | null };
    const deltas: number[] = [];
    const base = {
      repoPath: '/repo',
      threadId: 'thoughts-switch',
      setRunningTotal: vi.fn(),
      setTokenCount: (value: number) => deltas.push(value),
      telemetryBindingRef: bindingRef,
      telemetryTotalRef: totalRef,
    };

    await refreshOrchestratorTokenTelemetry({ ...base, backend: 'claude' });
    await refreshOrchestratorTokenTelemetry({ ...base, backend: 'codex' });

    expect(deltas).toEqual([0, 0]);
    expect(bindingRef.current).toBe('thoughts-switch\0codex');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/runtime/telemetry?threadId=thoughts-switch&backend=claude',
      '/api/runtime/telemetry?threadId=thoughts-switch&backend=codex',
    ]);
  });

  it('discards a late telemetry response after the active thread changes', async () => {
    let resolveOld: (response: Response) => void = () => {};
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => oldResponse)
      .mockResolvedValueOnce(new Response(JSON.stringify({ telemetry: { contextTokens: 4_000 } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const bindingRef = { current: null as string | null };
    const totalRef = { current: null as number | null };
    const runningTotals: number[] = [];
    const tokenDeltas: number[] = [];
    const shared = {
      repoPath: '/repo',
      backend: 'claude' as const,
      setRunningTotal: (value: number) => runningTotals.push(value),
      setTokenCount: (value: number) => tokenDeltas.push(value),
      telemetryBindingRef: bindingRef,
      telemetryTotalRef: totalRef,
    };

    const stale = refreshOrchestratorTokenTelemetry({ ...shared, threadId: 'thoughts-old' });
    const current = await refreshOrchestratorTokenTelemetry({ ...shared, threadId: 'thoughts-new' });
    resolveOld(new Response(JSON.stringify({ telemetry: { contextTokens: 190_000 } }), { status: 200 }));

    expect(current?.totalTokens).toBe(4_000);
    expect(await stale).toBeNull();
    expect(bindingRef.current).toBe('thoughts-new\0claude');
    expect(totalRef.current).toBe(4_000);
    expect(runningTotals).toEqual([4_000]);
    expect(tokenDeltas).toEqual([0]);
  });
});
