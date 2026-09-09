// @vitest-environment jsdom

import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapAcpUpdate } from '@/lib/acp/client';
import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import { renderLLMMarkdown } from '@/components/desktop/LLMMarkdown';
import { useOrchestratorStream } from '../useOrchestratorStream';
import type { OrchestratorStreamResult } from './types';

const transport = vi.hoisted(() => ({ socket: null as WebSocket | null }));
vi.mock('./shared', async (importOriginal) => ({
  ...await importOriginal<typeof import('./shared')>(),
  openOrchestratorWebSocket: () => transport.socket,
}));

let root: Root;
let host: HTMLDivElement;
let stream: OrchestratorStreamResult;
const threadId = 'thoughts-chunk-rendering';
const assistantMessageId = 'assistant-chunk-rendering';

function ThreadReply() {
  const result = useOrchestratorStream('/tmp/chunk-rendering', { threadId });
  useEffect(() => { stream = result; }, [result]);
  return createElement(Fragment, null, result.messages.map((message) => (
    createElement('article', { key: message.id }, renderLLMMarkdown(message.text))
  )));
}

function receive(event: string, data: Record<string, unknown>) {
  transport.socket!.onmessage!({
    data: JSON.stringify({ channel: 'orchestrator', event, data: { threadId, assistantMessageId, ...data } }),
  } as MessageEvent);
}

function receiveAcp(backend: OrchestratorBackendId, text: string, thinking = false) {
  const event = mapAcpUpdate({
    sessionUpdate: thinking ? 'agent_thought_chunk' : 'agent_message_chunk',
    content: { type: 'text', text },
  });
  if (event?.type !== 'text' && event?.type !== 'thinking') throw new Error('Expected an ACP text chunk');
  receive('output', { backend, text: event.text, thinking: event.type === 'thinking' });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  localStorage.clear();
  transport.socket = {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(ThreadReply)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  transport.socket = null;
  localStorage.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const sentence = "I'll read index.html first, then answer in one sentence with no edits.";
const markdownChunks = ['**Techn', 'ical change:', '** Persist ', 'the list in `local', 'Storage`.'];

describe('ACP chunks through the thread hook and Markdown renderer (#2117)', () => {
  it.each(['acp', 'hermes', 'opencode'] as const)('%s keeps arbitrary chunks intact while streaming and on completion', async (backend) => {
    // Single-character chunks include whitespace-only events and split every word.
    const chunks = Array.from(sentence);
    await act(async () => {
      for (const chunk of chunks.slice(0, -1)) receiveAcp(backend, chunk);
      vi.advanceTimersByTime(20);
    });
    expect(stream.messages[0]?.text).toBe(sentence.slice(0, -1));
    expect(host.querySelector('article')?.textContent).toBe(sentence.slice(0, -1));
    expect(host.querySelector('article')?.children).toHaveLength(1);

    // Completion must flush the last chunk even before its queued frame runs.
    await act(async () => {
      receiveAcp(backend, chunks.at(-1)!);
      receive('status', { backend, status: 'ready' });
    });
    expect(stream.status).toBe('ready');
    expect(stream.messages).toHaveLength(1);
    expect(stream.messages[0]?.text).toBe(sentence);
    expect(host.querySelector('article')?.textContent).toBe(sentence);
    await act(async () => vi.advanceTimersByTime(20));
    expect(stream.messages[0]?.text).toBe(sentence);
  });

  it.each(['acp', 'hermes', 'opencode'] as const)('%s preserves split emphasis, inline code, and explicit newlines', async (backend) => {
    const chunks = [...markdownChunks, '\n', '\nKeep ', 'the spacing.\nAnd this line.'];
    await act(async () => {
      // A tool can create the assistant state before its first text chunk.
      receive('tool-use', { backend, name: 'read_file', toolUseId: 'read-1', args: {} });
      receiveAcp(backend, 'Check the ', true);
      receiveAcp(backend, 'saved state.\nThen answer.', true);
      for (const chunk of chunks) receiveAcp(backend, chunk);
      receive('status', { backend, status: 'ready' });
    });
    expect(stream.messages[0]?.text).toBe(chunks.join(''));
    expect(stream.messages[0]?.thinking).toBe('Check the saved state.\nThen answer.');
    expect(host.querySelector('strong')?.textContent).toBe('Technical change:');
    expect(host.querySelector('code')?.textContent).toBe('localStorage');
    expect(host.querySelector('article')?.children).toHaveLength(4);
  });

  it.each(['claude', 'codex', 'o8'] as const)('renders the same completed text as the %s backend', async (backend) => {
    const text = markdownChunks.join('');
    await act(async () => {
      receive('output', { backend, text, thinking: false });
      receive('status', { backend, status: 'ready' });
    });
    const nativeMarkup = host.innerHTML;
    await act(async () => stream.reset());
    await act(async () => {
      for (const chunk of markdownChunks) receiveAcp('opencode', chunk);
      receive('status', { backend: 'opencode', status: 'ready' });
    });
    expect(stream.messages[0]?.text).toBe(text);
    expect(host.innerHTML).toBe(nativeMarkup);
  });
});
