// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArchitectureDeltaResult } from '@/lib/review/architecture-delta-types';
import { useArchitectureAttention } from './useArchitectureAttention';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

const scopePaths = ['src/a.ts'];
const analysis: ArchitectureDeltaResult = {
  ok: true,
  status: 'ready',
  reason: null,
  analysisId: 'a'.repeat(24),
  nodes: [{ path: 'src/a.ts', state: 'changed', focusPath: 'src/a.ts' }],
  edges: [],
  summary: { changedModules: 1, addedEdges: 0, removedEdges: 0, contextEdges: 0 },
  unsupportedPaths: [],
  omittedPaths: [],
  resolutionWarnings: [],
  truncated: false,
  generatedAt: '2026-09-21T00:00:00.000Z',
};

function Probe({ current }: { current: ArchitectureDeltaResult | null }) {
  const state = useArchitectureAttention({
    repoPath: '/repo',
    laneId: null,
    analysis: current,
    scopePaths,
    enabled: Boolean(current),
  });
  return createElement('span', { 'data-status': state.result?.status ?? (state.loading ? 'loading' : 'idle') });
}

describe('useArchitectureAttention', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock.mockReset().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        status: 'ready',
        reason: null,
        analysisId: analysis.analysisId,
        items: [],
        model: 'jev-latest',
        latencyMs: 100,
        receiptId: 'receipt-1',
        cached: false,
        generatedAt: '2026-09-21T00:00:01.000Z',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    vi.unstubAllGlobals();
    container.remove();
  });

  it('waits for deterministic graph evidence, then requests the matching scoped advisory result', async () => {
    await act(async () => { root.render(createElement(Probe, { current: null })); });
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => { root.render(createElement(Probe, { current: analysis })); });
    await vi.waitFor(() => expect(container.querySelector('span')?.getAttribute('data-status')).toBe('ready'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/review/architecture-attention?workspace=%2Frepo');
    expect(JSON.parse(options.body)).toEqual({
      expectedAnalysisId: analysis.analysisId,
      scopePaths,
    });
  });

  it('clears old advisory data while a new evidence revision is loading', async () => {
    await act(async () => { root.render(createElement(Probe, { current: analysis })); });
    await vi.waitFor(() => expect(container.querySelector('span')?.getAttribute('data-status')).toBe('ready'));

    let finish!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const next = { ...analysis, analysisId: 'b'.repeat(24) };
    await act(async () => { root.render(createElement(Probe, { current: next })); });

    await vi.waitFor(() => expect(container.querySelector('span')?.getAttribute('data-status')).toBe('loading'));
    await act(async () => {
      finish({
        ok: true,
        json: async () => ({
          ok: true,
          status: 'ready',
          reason: null,
          analysisId: next.analysisId,
          items: [],
          model: 'jev-latest',
          latencyMs: 100,
          receiptId: 'receipt-2',
          cached: false,
          generatedAt: '2026-09-21T00:00:02.000Z',
        }),
      });
    });
    await vi.waitFor(() => expect(container.querySelector('span')?.getAttribute('data-status')).toBe('ready'));
  });
});
