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
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ runs: [] }), { status: 200 }));
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

  it('keeps an externally unverified run visible', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ runs: [{
      id: 'pending', session: 'cortex-run-pending', command: 'host coordinator', status: 'settling',
    }] }), { status: 200 }));
    await act(async () => root.render(createElement(OrchestratorRunStrip, { active: true })));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(container.textContent).toContain('Settlement unverified');
    expect(container.querySelector('[aria-label="Verify stop"]')).not.toBeNull();
  });

  it('keeps stop busy and reports an unverified result without hiding the run', async () => {
    const run = { id: 'stopping', session: 'cortex-run-stopping', command: 'host coordinator', status: 'running' };
    let finishStop: ((value: Response) => void) | undefined;
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      if ((args[1] as RequestInit | undefined)?.method === 'POST') return new Promise<Response>((resolve) => { finishStop = resolve; });
      return new Response(JSON.stringify({ runs: [run] }), { status: 200 });
    });
    await act(async () => root.render(createElement(OrchestratorRunStrip, { active: true })));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const stop = container.querySelector('[data-run-stop]') as HTMLButtonElement;
    await act(async () => stop.click());
    expect(stop.disabled).toBe(true);
    expect(container.textContent).toContain('Stopping and verifying');
    await act(async () => finishStop!(new Response(JSON.stringify({ ok: false, run: { ...run, status: 'settling' } }), { status: 409 })));
    expect(container.textContent).toContain('Stop unverified');
    expect(container.querySelector('[data-run-stop]')).not.toBeNull();
    expect(stop.disabled).toBe(false);
  });
});
