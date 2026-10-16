// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/desktop/onboarding/useRuntimeInventory', () => ({
  useRuntimeInventory: () => ({ inventory: [], loading: false, error: null, refresh: () => {} }),
}));
vi.mock('@/lib/llm/thread-auto-title', () => ({ maybeQueueThreadAutoTitle: vi.fn() }));
vi.mock('@/lib/repos/github-identity', () => ({ resolveRepoGithubIdentity: () => ({ githubOwner: null, githubRepo: null }) }));
vi.mock('@/lib/llm/thread-repo-metadata', () => ({ resolveThreadRepoMetadata: () => ({}) }));
const transport = vi.hoisted(() => ({ socket: null as WebSocket | null }));
vi.mock('@/components/desktop/thoughts/use-orchestrator-stream/shared', async (original) => ({
  ...await original<typeof import('@/components/desktop/thoughts/use-orchestrator-stream/shared')>(),
  openOrchestratorWebSocket: () => transport.socket,
}));

import { useOrchestratorStream } from '@/components/desktop/thoughts/useOrchestratorStream';
import { usePersistChatThread } from '@/components/desktop/thoughts/chat-panel/usePersistChatThread';
import type { OrchestratorSendHandle, OrchestratorStreamResult } from '@/components/desktop/thoughts/use-orchestrator-stream/types';
import { ORCHESTRATOR_SEND_ACK_TIMEOUT_MS } from '@/components/desktop/thoughts/use-orchestrator-stream/delivery';
import { deserializeStoredTranscript } from '@/lib/transcripts/history-serde';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { resolveDisplayMessages } from '@/components/desktop/thoughts/chat-panel/resolve-display-messages';
import { POST, GET } from '@/app/api/v2/chat-history/route';

let host: HTMLDivElement;
let root: Root;
let stream: OrchestratorStreamResult;
let displayed: MobileTranscriptEntry[];
let persist: ReturnType<typeof usePersistChatThread>;
let threadId: string;
let ordinal = 0;
const repoPath = '/synthetic/late-ack';
function Harness() {
  const result = useOrchestratorStream(repoPath, { threadId });
  const persistence = usePersistChatThread(repoPath, null);
  const [chatMessages, setChatMessages] = useState<MobileTranscriptEntry[]>([]);
  useEffect(() => {
    if (result.messages.length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Mirror the panel's retained-state effect for this regression.
    setChatMessages((previous) => resolveDisplayMessages({
      historyEntries: [], chatMessages: previous, streamMessages: result.messages,
    }));
  }, [result.messages]);
  const composed = resolveDisplayMessages({ historyEntries: [], chatMessages, streamMessages: result.messages });
  useEffect(() => { stream = result; persist = persistence; displayed = composed; }, [result, persistence, composed]);
  return createElement('output', null, composed.map((message) => message.id).join('|'));
}
async function event(name: string, data: Record<string, unknown> = {}) {
  await act(async () => transport.socket?.onmessage?.({ data: JSON.stringify({
    channel: 'orchestrator', event: name, data: { threadId, ...data },
  }) } as MessageEvent));
}
function sends() {
  return (transport.socket!.send as ReturnType<typeof vi.fn>).mock.calls
    .map(([payload]) => JSON.parse(payload as string) as { type: string })
    .filter((payload) => payload.type === 'orchestrator-send');
}
async function timeoutSend() {
  const previousSends = sends().length;
  let handle: OrchestratorSendHandle | null = null;
  await act(async () => { handle = stream.send('synthetic message', { backend: 'codex', model: 'gpt-5.6-sol' }); });
  expect(sends()).toHaveLength(previousSends + 1);
  await act(async () => { await vi.advanceTimersByTimeAsync(ORCHESTRATOR_SEND_ACK_TIMEOUT_MS + 1); });
  const sent = handle as unknown as OrchestratorSendHandle;
  expect(stream.messages.some((entry) => entry.id === `orch-delivery-error-${sent.clientMessageId}`)).toBe(true);
  return sent;
}
async function save() {
  await act(async () => { await persist.persistThreadNow(displayed, threadId, null); });
}
async function readSaved() {
  const response = await GET(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${threadId}`));
  expect(response.status).toBe(200);
  return (await response.json()).messages as Array<Record<string, unknown>>;
}
async function reloadSaved() {
  const messages = deserializeStoredTranscript(await readSaved());
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
  await act(async () => stream.replaceTranscript(messages));
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  threadId = `thoughts-late-ack-${++ordinal}`;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/v2/chat-history' && init?.method === 'POST') {
      return POST(new NextRequest('http://localhost/api/v2/chat-history', { ...init, signal: init.signal ?? undefined }));
    }
    return new Response('{}', { status: 200 });
  }));
  transport.socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
  await event('status', { status: 'ready', backend: 'codex', snapshot: true });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  transport.socket = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('late delivery settlement through the stream reducer and saved chat', () => {
  it('removes only the matching warning after late acknowledgement, including saved reload', async () => {
    const sent = await timeoutSend();
    await save();
    const before = await readSaved();
    const warningId = `orch-delivery-error-${sent.clientMessageId}`;
    expect(before.some((entry) => entry.id === warningId)).toBe(true);
    await event('send-ack', { clientMessageId: sent.clientMessageId });
    expect(stream.messages.some((entry) => entry.id === warningId)).toBe(false);
    expect(displayed.some((entry) => entry.id === warningId)).toBe(false);
    await save();
    expect((await readSaved()).some((entry) => entry.id === warningId)).toBe(false);
    // A delayed pre-ack writer must not restore the warning or erase delivery truth.
    expect((await POST(new NextRequest('http://localhost/api/v2/chat-history', {
      method: 'POST', body: JSON.stringify({ tabId: threadId, messages: before }),
    }))).status).toBe(200);
    expect((await readSaved()).some((entry) => entry.id === warningId)).toBe(false);
    await reloadSaved();
    expect(stream.messages.some((entry) => entry.id === warningId)).toBe(false);
    expect(stream.messages.find((entry) => entry.id === sent.userMessageId)?.deliveryConfirmed).toBe(true);
    await act(async () => stream.retryPendingSend(sent.clientMessageId));
    expect(sends()).toHaveLength(1);
  });

  it('keeps an unacknowledged warning after an unrelated acknowledgement and reload', async () => {
    const sent = await timeoutSend();
    await event('send-ack', { clientMessageId: 'unrelated' });
    await save();
    await reloadSaved();
    expect(stream.messages.some((entry) => entry.id === `orch-delivery-error-${sent.clientMessageId}`)).toBe(true);
    expect(sends()).toHaveLength(1);
  });
});


describe('late delivery identity and activity controls', () => {
  it('does not settle from an acknowledgement in a different thread or a snapshot', async () => {
    const sent = await timeoutSend();
    await event('send-ack', { clientMessageId: sent.clientMessageId, threadId: 'thoughts-other' });
    await event('status', { status: 'ready', snapshot: true });
    expect(stream.messages.some((entry) => entry.id === `orch-delivery-error-${sent.clientMessageId}`)).toBe(true);
    expect(stream.messages.find((entry) => entry.id === sent.userMessageId)?.deliveryConfirmed).not.toBe(true);
  });

  it('clears a saved warning on live output without claiming turn completion', async () => {
    const sent = await timeoutSend();
    await save();
    await event('output', { text: 'synthetic ongoing output', backend: 'codex' });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(stream.messages.some((entry) => entry.id === `orch-delivery-error-${sent.clientMessageId}`)).toBe(false);
    await save();
    await reloadSaved();
    expect(stream.messages.some((entry) => entry.id === `orch-delivery-error-${sent.clientMessageId}`)).toBe(false);
    expect(stream.messages.find((entry) => entry.id === sent.userMessageId)?.deliveryConfirmed).toBe(true);
    expect(sends()).toHaveLength(1);
  });

  it('retains unrelated stored warnings and unseen assistant messages on a partial save', async () => {
    const sent = await timeoutSend();
    await save();
    const before = await readSaved();
    const unrelated = { id: 'orch-delivery-error-other-send', role: 'system', content: 'unacknowledged', timestamp: Date.now() };
    const unseen = { id: 'unseen-assistant', role: 'assistant', content: 'saved elsewhere', timestamp: Date.now() };
    expect((await POST(new NextRequest('http://localhost/api/v2/chat-history', {
      method: 'POST', body: JSON.stringify({ tabId: threadId, messages: [...before, unrelated, unseen] }),
    }))).status).toBe(200);
    await event('send-ack', { clientMessageId: sent.clientMessageId });
    await save();
    expect((await readSaved()).map((entry) => entry.id)).toContain(unrelated.id);
    expect((await readSaved()).map((entry) => entry.id)).toContain(unseen.id);
    expect((await readSaved()).map((entry) => entry.id)).not.toContain(`orch-delivery-error-${sent.clientMessageId}`);
  });

  it('keeps retry available for a never-acknowledged send after reload', async () => {
    const sent = await timeoutSend();
    await save();
    await reloadSaved();
    expect(stream.messages.some((entry) => entry.id === `orch-delivery-error-${sent.clientMessageId}`)).toBe(true);
    await act(async () => stream.retryPendingSend(sent.clientMessageId));
    expect(sends()).toHaveLength(2);
    expect(sends()[1]).toMatchObject({ clientMessageId: sent.clientMessageId, threadId });
  });
});


it('retains separate delivery confirmations for consecutive identical messages', async () => {
  const first = await timeoutSend();
  await event('send-ack', { clientMessageId: first.clientMessageId });
  await save();
  const second = await timeoutSend();
  await save();
  const stale = await readSaved();
  await event('send-ack', { clientMessageId: second.clientMessageId });
  await save();
  expect((await readSaved()).some((entry) => entry.id === `orch-delivery-error-${second.clientMessageId}`)).toBe(false);
  expect((await POST(new NextRequest('http://localhost/api/v2/chat-history', {
    method: 'POST', body: JSON.stringify({ tabId: threadId, messages: stale }),
  }))).status).toBe(200);
  await reloadSaved();
  expect(stream.messages.filter((entry) => entry.deliveryConfirmed === true).map((entry) => entry.id))
    .toEqual([first.userMessageId, second.userMessageId]);
  expect(stream.messages.some((entry) => entry.id === `orch-delivery-error-${second.clientMessageId}`)).toBe(false);
  expect(sends()).toHaveLength(2);
});
