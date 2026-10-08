// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatGPTPlanConnection } from './ChatGPTPlanConnection';
import { useLLMChatLifecycle } from '../llm-chat/useLLMChatLifecycle';
import { API_MODELS } from '../llm-chat/shared';

const fixture = vi.hoisted(() => ({ account: 'fixture-owner' as string | null, request: vi.fn(), open: vi.fn(), saved: { model: 'chatgpt:fixture-plan-model', messages: [{ id: 'fixture-message', role: 'user', content: 'A plan conversation', timestamp: 1 }] } }));
vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => ({ isLoaded: true, signedIn: Boolean(fixture.account), user: fixture.account ? { id: fixture.account } : null, signIn: vi.fn() }) }));
vi.mock('@/lib/chatgpt-plan/client', () => ({ planConnectionRequest: (...args: unknown[]) => fixture.request(...args) }));
vi.mock('@/lib/desktop/open-external', () => ({ openExternalUrl: (...args: unknown[]) => fixture.open(...args) }));
vi.mock('@/lib/llm/chat-history', () => ({ loadChatHistory: async () => fixture.saved, saveChatHistory: vi.fn() }));

let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fixture.account = 'fixture-owner'; fixture.request.mockReset(); fixture.open.mockReset();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const connected = { connected: true, planEnabled: true, activeId: 'fixture-account', accounts: [{ id: 'fixture-account', label: 'private-owner@example.test', connected: true }], models: [], welcomed: true, modelLoadError: 'Private discovery notice' };
const empty = { connected: false, planEnabled: false, activeId: null, accounts: [], models: [], welcomed: false };
function button(text: string) { return Array.from(container.querySelectorAll('button')).find((entry) => entry.textContent === text)!; }

it.each(['other-owner', null])('hides private details and confirmation in the first commit for %s', async (nextOwner) => {
  const commits: string[] = [];
  function Harness() {
    useLayoutEffect(() => { commits.push(container.textContent ?? ''); });
    return createElement(ChatGPTPlanConnection);
  }
  fixture.request.mockResolvedValue(connected);
  await act(async () => root.render(createElement(Harness)));
  await act(async () => button('Disconnect').click());
  expect(container.textContent).toContain('Stop this ChatGPT connection?');
  commits.length = 0;
  fixture.account = nextOwner;
  fixture.request.mockResolvedValue(empty);
  await act(async () => root.render(createElement(Harness)));
  expect(commits[0]).not.toContain('private-owner@example.test');
  expect(commits[0]).not.toContain('Private discovery notice');
  expect(commits[0]).not.toContain('Stop this ChatGPT connection?');
  expect(container.textContent).not.toContain('Stop this ChatGPT connection?');
});

it('ignores an earlier owner start reply and clears busy state for the next owner', async () => {
  fixture.request.mockResolvedValue(connected);
  await act(async () => root.render(createElement(ChatGPTPlanConnection)));
  let resolve!: (value: unknown) => void;
  fixture.request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await act(async () => button('Continue with ChatGPT').click());
  fixture.account = 'other-owner';
  fixture.request.mockResolvedValue(empty);
  await act(async () => root.render(createElement(ChatGPTPlanConnection)));
  await act(async () => resolve({ attemptId: 'old-attempt', authorizationUrl: 'https://auth.openai.com/api/accounts/authorize?state=fixture' }));
  expect(fixture.open).not.toHaveBeenCalled();
  expect(button('Continue with ChatGPT').disabled).toBe(false);
  expect(container.textContent).not.toContain('private-owner@example.test');
});

it('rejects a delayed status reply even when the same owner returns later', async () => {
  let resolve!: (value: unknown) => void;
  fixture.request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await act(async () => root.render(createElement(ChatGPTPlanConnection)));
  fixture.account = 'other-owner'; fixture.request.mockResolvedValue(empty);
  await act(async () => root.render(createElement(ChatGPTPlanConnection)));
  fixture.account = 'fixture-owner';
  await act(async () => root.render(createElement(ChatGPTPlanConnection)));
  await act(async () => resolve(connected));
  expect(container.textContent).not.toContain('private-owner@example.test');
  expect(container.textContent).not.toContain('Private discovery notice');
});

it('keeps Disconnect visible when plan model discovery fails', async () => {
  fixture.request.mockResolvedValue({ connected: true, planEnabled: false, activeId: 'fixture-account', accounts: [{ id: 'fixture-account', label: 'Fixture account', connected: true }], models: [], welcomed: true, modelLoadError: 'Models temporarily unavailable' });
  await act(async () => root.render(createElement(ChatGPTPlanConnection)));
  expect(container.textContent).toContain('Disconnect'); expect(container.textContent).toContain('Models temporarily unavailable');
});

it('retries the retained registration after a failed first exchange instead of creating another dynamic client', async () => {
  fixture.request.mockImplementation(async (_path?: string, init?: RequestInit) => init?.method === 'POST' ? { attemptId: 'fixture-attempt', authorizationUrl: 'https://auth.openai.com/api/accounts/authorize?state=fixture' } : { connected: false, planEnabled: false, activeId: null, accounts: [{ id: 'fixture-retained-client', label: 'Fixture registration', connected: false }], models: [], welcomed: false });
  await act(async () => root.render(createElement(ChatGPTPlanConnection)));
  const button = Array.from(container.querySelectorAll('button')).find((entry) => entry.textContent === 'Continue with ChatGPT');
  await act(async () => button?.click());
  const call = fixture.request.mock.calls.find((entry) => entry[1]?.method === 'POST');
  expect(JSON.parse(call![1].body)).toEqual({ action: 'start', accountId: 'fixture-retained-client' });
  expect(fixture.open).toHaveBeenCalledTimes(1);
});

it('restores a saved ChatGPT model while discovery is empty without choosing another provider', async () => {
  const setModel = vi.fn(); const nothing = vi.fn();
  const props = { allModels: API_MODELS, model: API_MODELS[0], modelResolved: false, tabId: 'fixture-chat', messages: [], streamContent: '', isStreaming: false, isUserScrolledUp: false, buildPersistedMessages: () => [], abortRef: { current: null }, handledDraftInjectionRef: { current: null }, inputRef: { current: null }, saveTimerRef: { current: null }, scrollRef: { current: null }, setModel, setModelResolved: nothing, setMessages: nothing, setActiveThinking: nothing, setActiveToolCalls: nothing, setApprovedToolsSet: nothing, setAttachedFiles: nothing, setAttachedImages: nothing, setEditedCommand: nothing, setFollowUps: nothing, setInput: nothing, setIsStreaming: nothing, setIsUserScrolledUp: nothing, setPendingApproval: nothing, setQueuedContextCards: nothing, setShowTypingIndicator: nothing, setStreamContent: nothing };
  function Harness() { useLLMChatLifecycle(props); return null; }
  await act(async () => root.render(createElement(Harness)));
  expect(setModel).toHaveBeenCalledWith(expect.objectContaining({ id: 'chatgpt:fixture-plan-model', provider: 'chatgpt' }));
  expect(setModel.mock.calls.some(([model]) => model.provider !== 'chatgpt')).toBe(false);
});
