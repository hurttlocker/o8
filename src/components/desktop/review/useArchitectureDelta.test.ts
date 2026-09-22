// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useArchitectureDelta } from './useArchitectureDelta';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ analysisKey }: { analysisKey: unknown }) {
  useArchitectureDelta({
    repoPath: '/repo',
    laneId: null,
    analysisKey,
    enabled: true,
  });
  return null;
}

describe('useArchitectureDelta refresh identity', () => {
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
        nodes: [],
        edges: [],
        summary: { changedModules: 0, addedEdges: 0, removedEdges: 0, contextEdges: 0 },
        unsupportedPaths: [],
        omittedPaths: [],
        resolutionWarnings: [],
        truncated: false,
        generatedAt: '2026-09-21T00:00:00.000Z',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('refreshes when a new change snapshot has the same path and line counts', async () => {
    await act(async () => {
      root.render(createElement(Probe, { analysisKey: [{ path: 'src/a.ts', additions: 1, deletions: 1 }] }));
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      root.render(createElement(Probe, { analysisKey: [{ path: 'src/a.ts', additions: 1, deletions: 1 }] }));
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
