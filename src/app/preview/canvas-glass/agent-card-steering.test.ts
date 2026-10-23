// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AgentGlassCard, type AgentCard } from './agent-card';

vi.mock('./card-shell', () => ({
  GlassCardShell: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  ShellAction: () => null,
}));
vi.mock('./use-agent-transcript', () => ({
  useAgentTranscript: () => ({ events: [], status: 'ready' }),
}));

it('the canvas composer sends explicit operator provenance with its correlated steer', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const fetchMock = vi.fn(async () => Response.json({ ok: true, result: {} }));
  vi.stubGlobal('fetch', fetchMock);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const noop = () => {};
  const card: AgentCard = {
    id: 1, x: 0, y: 0, z: 1, w: 420, h: 280, laneId: 'fixture-lane',
    packetId: 'fixture-packet', sessionKey: null, repoPath: null, startedAt: null,
    expanded: true, number: 1, codename: 'Worker', title: 'Fixture task', runtime: 'codex',
  };
  try {
    await act(async () => root.render(createElement(AgentGlassCard, {
      card, lane: null, onMove: noop, onResize: noop, onFocus: noop,
      onClose: noop, onReview: noop, onToggleExpand: noop,
    })));
    const input = container.querySelector<HTMLInputElement>('[aria-label="Message this agent"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Keep the existing public API');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchMock).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/orchestrator/steer-packet');
    expect(JSON.parse(String(init.body))).toEqual({
      packetId: card.packetId, message: 'Keep the existing public API',
      source: 'operator', idempotencyKey: expect.any(String),
    });
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
