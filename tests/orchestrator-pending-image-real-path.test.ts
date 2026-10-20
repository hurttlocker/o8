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
let initialHistory: MobileTranscriptEntry[] = [];
const image = { name: 'fixture.png', dataUri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==' };
let persist: ReturnType<typeof usePersistChatThread>;
let threadId: string;
let ordinal = 0;
const repoPath = '/synthetic/pending-image';
function Harness() {
  const result = useOrchestratorStream(repoPath, { threadId });
  const persistence = usePersistChatThread(repoPath, null);
  const [chatMessages, setChatMessages] = useState<MobileTranscriptEntry[]>(initialHistory);
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
  await act(async () => { handle = stream.send('synthetic message', { backend: 'codex', model: 'gpt-5.6-sol', attachments: [image] }); });
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
  initialHistory = deserializeStoredTranscript(await readSaved());
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear(); initialHistory = [];
  threadId = `thoughts-pending-image-${++ordinal}`;
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


describe('pending image identity through the stream and saved transcript', () => {
  it('recovers the original image after a pre-acceptance restart and retries the exact original wire message', async () => {
    const sent = await timeoutSend();
    expect(displayed.find(entry => entry.id === sent.userMessageId)?.media?.[0]?.path).toBe(image.dataUri);
    await save();
    expect(JSON.stringify(await readSaved())).not.toContain(image.dataUri);
    await reloadSaved();
    expect(displayed.find(entry => entry.id === sent.userMessageId)?.media?.[0]).toMatchObject({ kind: 'image', name: image.name, path: image.dataUri });
    expect(sends()).toHaveLength(1);
    await act(async () => stream.retryPendingSend(sent.clientMessageId));
    expect(sends()).toHaveLength(2);
    expect(sends()[1]).toEqual(sends()[0]);
  });

  it('requires reattachment when quota retained only the attempt identity, without sending a text-only retry', async () => {
    const setItem = Storage.prototype.setItem;
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, key, value) {
      if (key.startsWith('o8:orchestrator-pending-send:v1:') && value.includes('wirePayload')) throw new DOMException('full', 'QuotaExceededError');
      return setItem.call(this, key, value);
    });
    const sent = await timeoutSend();
    write.mockRestore();
    await save(); await reloadSaved();
    expect(displayed.some(entry => entry.text.includes('Reattach it'))).toBe(true);
    await act(async () => stream.retryPendingSend(sent.clientMessageId));
    expect(sends()).toHaveLength(1);
    expect(displayed.some(entry => entry.id === sent.userMessageId)).toBe(true);
  });

  it('refuses a recovered image attempt whose wire payload no longer contains the required image', async () => {
    const sent = await timeoutSend();
    const key = Object.keys(localStorage).find(key => key.startsWith('o8:orchestrator-pending-send:v1:'))!;
    const record = JSON.parse(localStorage.getItem(key)!);
    record.wirePayload = JSON.stringify({ ...JSON.parse(record.wirePayload), attachments: [] });
    localStorage.setItem(key, JSON.stringify(record));
    await save(); await reloadSaved();
    expect(displayed.some(entry => entry.text.includes('Reattach it'))).toBe(true);
    await act(async () => stream.retryPendingSend(sent.clientMessageId));
    expect(sends()).toHaveLength(1);
  });
});
