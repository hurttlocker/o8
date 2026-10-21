// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const fixtures = vi.hoisted(() => ({ bootstrap: vi.fn().mockResolvedValue(undefined), slice: { status: 'idle' }, packet: { entries: [], activity: [] } }));
vi.mock('@/lib/transcripts/bootstrap', () => ({ bootstrapTranscripts: fixtures.bootstrap }));
vi.mock('@/lib/transcripts/useTranscript', () => ({ useTranscript: () => fixtures.slice }));
vi.mock('./use-packet-transcript-poll', () => ({ shouldPollPacketTranscript: () => false, usePacketTranscriptPoll: () => fixtures.packet }));
vi.mock('./useWorkspaceChatModelOptions', () => ({ useWorkspaceChatModelOptions: () => ({ availableModels: [], selectedModel: { id: '', label: 'Default', color: '' } }) }));
vi.mock('@/lib/transcripts/store', () => ({ transcriptStore: { setSlice: vi.fn(), setStatus: vi.fn() } }));
import { useWorkspaceChatPane } from './useWorkspaceChatPane';
import { resetWorkspaceChatDraftStatesForTests } from './workspace-chat-drafts';
import { resetWorkspaceSteerQueueForTests } from './workspace-chat-queue';
import type { TerminalTab } from './types';
let root: Root; let host: HTMLDivElement; let chat: ReturnType<typeof useWorkspaceChatPane>; let active = false;
let tab: TerminalTab;
function Harness() { const current = useWorkspaceChatPane({ tab, active, onUpdateMessages: vi.fn(), onUpdateSessionKey: vi.fn(), onSelectModel: vi.fn(), onConsumeDraftInjection: vi.fn() }); useEffect(() => { chat = current; }, [current]); return createElement('div', null, current.draft); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); fixtures.bootstrap.mockReset().mockResolvedValue(undefined);
  active = false; tab = { id: 'fixture', kind: 'chat', chatRuntime: 'muse', chatSessionKey: 'muse-owned:fixture', repo: { localPath: '/fixture' }, chatMessages: [] } as unknown as TerminalTab;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith('/api/runtime/inventory')
    ? { agents: [{ sessionKey: tab.chatSessionKey, runtimeSurface: { capabilities: { sendInput: true } } }] }
    : { ok: true, status: 'completed' }))));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetWorkspaceChatDraftStatesForTests(); resetWorkspaceSteerQueueForTests(); vi.unstubAllGlobals(); });
it('steers an owned native runtime through its authoritative generic action path', async () => {
  await act(async () => root.render(createElement(Harness)));
  let outcome: string | undefined; await act(async () => { outcome = await chat.sendText('native steer'); });
  expect(outcome).toBe('accepted');
  const actions = vi.mocked(fetch).mock.calls.filter(call => call[0] === '/api/runtime/action');
  expect(actions).toHaveLength(1); expect(JSON.parse(actions[0][1]!.body as string)).toMatchObject({ action: 'steer', surfaceId: tab.chatSessionKey, message: 'native steer' });
});
it('keeps an accepted receipt accepted even when transcript refresh fails', async () => {
  await act(async () => root.render(createElement(Harness)));
  fixtures.bootstrap.mockRejectedValue(new Error('offline transcript'));
  let outcome: string | undefined; await act(async () => { outcome = await chat.sendText('already delivered'); });
  expect(outcome).toBe('accepted'); expect(chat.pendingSteers).toHaveLength(0);
});
it('does not send two commands while readiness is pending', async () => {
  await act(async () => root.render(createElement(Harness)));
  let release!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  let first!: Promise<string>; let second!: Promise<string>;
  await act(async () => { first = chat.sendText('first'); second = chat.sendText('second'); });
  await expect(second).resolves.toBe('failed');
  await act(async () => { release(new Response(JSON.stringify({ agents: [{ sessionKey: tab.chatSessionKey, runtimeSurface: { capabilities: { sendInput: true } } }] }))); await first; });
  expect(vi.mocked(fetch).mock.calls.filter(call => call[0] === '/api/runtime/action')).toHaveLength(1);
});
it('holds the actual unknown 409 action receipt rather than treating it as a rejected command', async () => {
  await act(async () => root.render(createElement(Harness)));
  vi.mocked(fetch).mockImplementation(async url => new Response(JSON.stringify(String(url).includes('inventory')
    ? { agents: [{ sessionKey: tab.chatSessionKey, runtimeSurface: { capabilities: { sendInput: true } } }] }
    : { ok: false, outcomeUnknown: true, status: 'unavailable' }), { status: String(url).includes('inventory') ? 200 : 409 }));
  let outcome: string | undefined; await act(async () => { outcome = await chat.sendText('unknown execution'); });
  expect(outcome).toBe('unconfirmed');
  expect(chat.sending).toBe(true);
  await act(async () => { expect(await chat.sendText('do not repeat')).toBe('failed'); });
  expect(vi.mocked(fetch).mock.calls.filter(call => call[0] === '/api/runtime/action')).toHaveLength(1);
});
it('preserves queued mutation identity and blocks Resume after an unknown action receipt', async () => {
  let ready = false;
  vi.mocked(fetch).mockImplementation(async url => new Response(JSON.stringify(String(url).includes('inventory')
    ? { agents: [{ sessionKey: tab.chatSessionKey, runtimeSurface: { capabilities: { sendInput: ready } } }] }
    : { ok: false, outcomeUnknown: true, status: 'unavailable' }), { status: String(url).includes('inventory') ? 200 : 409 }));
  await act(async () => root.render(createElement(Harness)));
  await act(async () => { expect(await chat.sendText('queued unknown')).toBe('queued'); });
  const id = chat.pendingSteers[0].mutationId; ready = true; active = true;
  await act(async () => root.render(createElement(Harness)));
  expect(chat.pendingSteers[0].status).toBe('unconfirmed'); expect(chat.pendingSteers[0].mutationId).toBe(id);
  await act(async () => chat.resumeQueue());
  expect(vi.mocked(fetch).mock.calls.filter(call => call[0] === '/api/runtime/action')).toHaveLength(1);
});
it('preserves an unsent intent when HTTP 200 carries a proven CLI spawn rejection', async () => {
  active = true; tab = { ...tab, chatRuntime: 'codex', chatSessionKey: 'codex-discovered:fixture' };
  vi.mocked(fetch).mockResolvedValue(new Response('data: {"type":"error","delivery":"rejected","text":"spawn failed"}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  await act(async () => root.render(createElement(Harness)));
  let outcome: string | undefined; await act(async () => { outcome = await chat.sendText('not executed'); });
  expect(outcome).toBe('failed');
});
it('holds an empty stream and accepts positive runtime output', async () => {
  active = true; tab = { ...tab, chatRuntime: 'codex', chatSessionKey: 'codex-discovered:fixture' };
  vi.mocked(fetch).mockResolvedValueOnce(new Response('')).mockResolvedValue(new Response('data: {"type":"delta","text":"received"}\n\n'));
  await act(async () => root.render(createElement(Harness)));
  await act(async () => { expect(await chat.sendText('unknown')).toBe('unconfirmed'); });
  await act(async () => { expect(await chat.sendText('acknowledged')).toBe('accepted'); });
});
