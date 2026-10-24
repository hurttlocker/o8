// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useOrchestratorStream } from '../useOrchestratorStream';
import type { OrchestratorStreamResult } from './types';

const transport = vi.hoisted(() => ({ socket: null as WebSocket | null }));
vi.mock('./shared', async (original) => ({
  ...await original<typeof import('./shared')>(),
  openOrchestratorWebSocket: () => transport.socket,
}));
let root: Root;
let host: HTMLDivElement;
let stream: OrchestratorStreamResult;
const threadId = 'thoughts-background-flush';
function Thread({ visible }: { visible: boolean }) {
  const result = useOrchestratorStream('/fixture/background-flush', { threadId, visible });
  useEffect(() => { stream = result; }, [result]);
  return createElement('article', null, result.messages.map(message => message.text).join(''));
}
async function render(visible: boolean) {
  await act(async () => root.render(createElement(Thread, { visible })));
}
function receive(event: string, data: Record<string, unknown>) {
  transport.socket!.onmessage!({ data: JSON.stringify({ channel: 'orchestrator', event,
    data: { threadId, assistantMessageId: 'assistant-background', backend: 'opencode', ...data },
  }) } as MessageEvent);
}
async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTime(ms));
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  transport.socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await render(false);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); localStorage.clear(); vi.clearAllTimers(); vi.useRealTimers();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
it('bounds hidden text paints while retaining every chunk and catches up when shown', async () => {
  for (let i = 0; i < 10; i++) {
    await act(async () => receive('output', { text: `${i} ` }));
    await advance(50);
  }
  expect(host.textContent).toBe('');
  await advance(500);
  expect(host.textContent).toBe('0 1 2 3 4 5 6 7 8 9 ');
  await act(async () => receive('output', { text: 'tail' }));
  await advance(20);
  expect(host.textContent).not.toContain('tail');
  await render(true);
  expect(host.textContent).toBe('0 1 2 3 4 5 6 7 8 9 tail');
  expect(transport.socket!.send).not.toHaveBeenCalledWith(expect.stringContaining('unsubscribe'));
});
it('keeps visible text frame-coalesced', async () => {
  await render(true);
  await act(async () => { receive('output', { text: 'one ' }); receive('output', { text: 'two' }); });
  expect(host.textContent).toBe('');
  await advance(20);
  expect(host.textContent).toBe('one two');
});
it('moves a queued visible frame to the background cadence when hidden', async () => {
  await render(true);
  await act(async () => receive('output', { text: 'pending' }));
  await render(false);
  await advance(20);
  expect(host.textContent).toBe('');
  await advance(980);
  expect(host.textContent).toBe('pending');
});
it('throttles a background window and flushes immediately when it becomes visible', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await render(true);
  await act(async () => receive('output', { text: 'window-hidden' }));
  await advance(20);
  expect(host.textContent).toBe('');
  visibility.mockReturnValue('visible');
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(host.textContent).toBe('window-hidden');
});
it('keeps tools, questions and terminal output immediate while hidden', async () => {
  await act(async () => {
    receive('output', { text: 'answer' });
    receive('tool-use', { name: 'AskUserQuestion', toolUseId: 'ask', args: { question: 'Continue?' } });
  });
  expect(stream.messages[0]?.toolCalls?.[0]?.args).toEqual({ question: 'Continue?' });
  await act(async () => receive('status', { status: 'ready' }));
  expect(host.textContent).toBe('answer');
  expect(stream.status).toBe('ready');
  await advance(1000);
  expect(host.textContent).toBe('answer');
});
it('cancels pending work on unmount', async () => {
  await act(async () => receive('output', { text: 'pending' }));
  await act(async () => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  root = createRoot(host);
  await advance(2000);
  expect(host.textContent).toBe('');
});
it.each(['dead', 'error'])('flushes pending hidden text before a %s terminal event', async terminal => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await act(async () => receive('output', { text: 'last answer' }));
  await act(async () => {
    if (terminal === 'dead') receive('status', { status: 'dead' });
    else receive('error', { error: 'fixture failure' });
  });
  expect(host.textContent).toContain('last answer');
  expect(stream.status).toBe(terminal);
});
