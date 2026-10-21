// @vitest-environment jsdom

import { act, createElement, useEffect, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AssistantRuntimeProvider, useAssistantRuntime, useLocalRuntime, type AssistantRuntime } from '@assistant-ui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerBar } from './mobile-assistant-chat-ui';
import { createMobileChatModel } from './mobile-assistant-chat-model';
import { useDrainAssistantQueueOnline, wrapWithOfflineQueue } from './mobile-assistant-offline';
import { clearPending, getPendingQueue } from '@/lib/mobile/pending-queue';
import { getMobilePalette, type ModelOption } from './mobile-approvals-shared';

const voice = vi.hoisted(() => ({
  transcript: '', isRecording: false, supported: true, tooltip: null,
  pointerHandlers: {}, claimSuppressedClick: () => false, flashTooltip: () => {},
}));
vi.mock('@/lib/mobile/use-press-to-dictate', () => ({ usePressToDictate: () => voice }));
vi.mock('@/lib/mobile/sounds', () => ({ playSendClick: () => {} }));

const utterance = 'fix the target';
const model: ModelOption = { id: 'fixture', label: 'Fixture', provider: 'openai', description: 'Fixture', backend: 'api' };
const resolution = {
  kind: 'choice', id: 'fixture-choice', question: 'Which target?',
  options: [{ label: 'Client', value: 'client' }, { label: 'Server', value: 'server' }], aodlPath: 'intent.target',
};
let runtime: AssistantRuntime;
let root: Root;
let host: HTMLDivElement;
let requests: Array<{ messages: Array<{ role: string; content: string }> }>;
let resolveInference: ((response: Response) => void) | undefined;
let delayedInference = false;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Capture({ threadId, repoPath }: { threadId: string; repoPath: string }) {
  const assistantRuntime = useAssistantRuntime();
  useEffect(() => { runtime = assistantRuntime; }, [assistantRuntime]);
  useDrainAssistantQueueOnline(threadId, repoPath);
  return null;
}
function Harness({ threadId = 'chat-one', repoPath = '/fixture/repo' }: { threadId?: string; repoPath?: string }) {
  const adapter = useMemo(() => wrapWithOfflineQueue(createMobileChatModel(model, repoPath, undefined, threadId), threadId, repoPath), [repoPath, threadId]);
  const localRuntime = useLocalRuntime(adapter);
  return createElement(AssistantRuntimeProvider, { runtime: localRuntime },
    createElement(Capture, { threadId, repoPath }), createElement(ComposerBar, { palette: getMobilePalette('dark'), selectedModel: model, repoPath, threadId }));
}
async function render(props: { threadId?: string; repoPath?: string } = {}) {
  await act(async () => { root.render(createElement(Harness, props)); });
}
async function dictate() {
  voice.transcript = '';
  await render();
  voice.transcript = utterance;
  await render();
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((entry) => entry.textContent === label);
  expect(button).toBeTruthy();
  await act(async () => { button!.click(); });
}
async function submit() {
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await vi.waitFor(() => expect(runtime.thread.getState().isRunning).toBe(false));
}
function hasPatch(index: number) {
  return requests[index].messages.some((message) => message.role === 'system' && message.content.includes('intent.target'));
}

describe('mobile composer confirmation through assistant-ui send and model dispatch', () => {
  beforeEach(async () => {
    voice.transcript = ''; delayedInference = false; resolveInference = undefined; requests = [];
    window.localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: RequestInit) => {
      if (url === '/api/mobile/ripple/resolve') {
        if (delayedInference) return new Promise<Response>((resolve) => { resolveInference = resolve; });
        return Response.json(resolution);
      }
      requests.push(JSON.parse(String(init.body)));
      return new Response('data: {"type":"content","text":"done"}\n\ndata: {"type":"done"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    }));
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await render();
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); clearPending('assistant', 'chat-one'); });

  it('sends only after the user submits and never reuses a choice for repeated words', async () => {
    await dictate(); await click('Client');
    expect(requests).toHaveLength(0);
    await submit(); expect(hasPatch(0)).toBe(true);
    const messageId = runtime.thread.getState().messages.find((message) => message.role === 'user')!.id;
    const receipt = JSON.parse(window.localStorage.getItem('o8.ripple.episodes.v1')!).at(-1);
    expect(receipt).toMatchObject({ messageId, scope: { threadId: 'chat-one', repoPath: '/fixture/repo' } });
    await act(async () => runtime.thread.composer.setText(utterance));
    await submit(); expect(hasPatch(1)).toBe(false);
  });

  it('invalidates an accepted choice on edit, even if the exact words are immediately restored', async () => {
    await dictate(); await click('Client');
    await act(async () => { runtime.thread.composer.setText('edited'); runtime.thread.composer.setText(utterance); });
    await submit(); expect(hasPatch(0)).toBe(false);
  });

  it.each([{ repoPath: '/fixture/other' }, { threadId: 'chat-two' }])('invalidates a choice on scope change without replaying dictation (%j)', async (props) => {
    await dictate(); await click('Client');
    await render(props);
    expect(runtime.thread.composer.getState().text).toBe(utterance);
    expect(host.querySelector('[aria-label="Resolve intent"]')).toBeNull();
    await submit(); expect(hasPatch(0)).toBe(false);
  });

  it('drops an inference response arriving after submission', async () => {
    delayedInference = true;
    await dictate();
    expect(resolveInference).toBeTypeOf('function');
    await submit(); expect(hasPatch(0)).toBe(false);
    await act(async () => { resolveInference!(Response.json(resolution)); });
    expect(host.querySelector('[aria-label="Resolve intent"]')).toBeNull();
  });

  it('preserves a confirmed choice through the production offline queue and actual reconnect drain', async () => {
    await dictate(); await click('Client');
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await submit(); expect(requests).toHaveLength(0);
    expect(getPendingQueue('assistant', 'chat-one')).toHaveLength(1);
    online.mockReturnValue(true);
    await act(async () => window.dispatchEvent(new Event('online')));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(hasPatch(0)).toBe(true);
    expect(getPendingQueue('assistant', 'chat-one')).toHaveLength(0);
    const messageId = runtime.thread.getState().messages.filter((message) => message.role === 'user').at(-1)!.id;
    expect(JSON.parse(window.localStorage.getItem('o8.ripple.episodes.v1')!).at(-1)).toMatchObject({ messageId });
  });

  it('holds a queued confirmation until its original repository is selected', async () => {
    await dictate(); await click('Client');
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await submit();
    await render({ repoPath: '/fixture/other' });
    online.mockReturnValue(true);
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(requests).toHaveLength(0);
    expect(getPendingQueue('assistant', 'chat-one')).toHaveLength(1);
    await render();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(hasPatch(0)).toBe(true);
  });

  it.each(['invalid', 'stale'])('keeps a %s queued confirmation from dispatching ambiguous text', async (kind) => {
    await dictate(); await click('Client');
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await submit();
    const key = 'o8:mobile:assistant-pending:chat-one';
    const items = JSON.parse(window.localStorage.getItem(key)!);
    if (kind === 'stale') items[0].queuedAt = Date.now() - 61 * 60 * 1000;
    else items[0].ripple.resolution.aodlPath = 'authority.write';
    window.localStorage.setItem(key, JSON.stringify(items));
    online.mockReturnValue(true);
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(requests).toHaveLength(0);
    expect(getPendingQueue('assistant', 'chat-one')).toHaveLength(1);
  });
});
