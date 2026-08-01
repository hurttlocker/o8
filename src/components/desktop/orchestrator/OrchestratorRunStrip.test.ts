// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/DesktopWebSocketContext', () => ({
  useWsConnectionState: () => 'connected',
}));

vi.mock('@/lib/runtimes/managed-runs/labels', () => ({
  deriveManagedRunLabel: () => 'Run',
}));

import { OrchestratorRunStrip } from './OrchestratorRunStrip';

describe('OrchestratorRunStrip idle refresh budget', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ runs: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('uses a five-minute fallback while realtime is connected', async () => {
    await act(async () => root.render(createElement(OrchestratorRunStrip, { active: true })));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(299_999); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
