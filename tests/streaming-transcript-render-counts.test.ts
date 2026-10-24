// @vitest-environment jsdom

import { act, createElement, createRef, useEffect, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { serializeTranscriptForStorage } from '@/lib/transcripts/history-serde';
import { ThoughtsChatPanel, type ThoughtsChatPanelHandle } from '@/components/desktop/thoughts/ThoughtsChatPanel';
import { resetComposerDraftMemoryForTests } from '@/components/desktop/thoughts/chat-panel/composer-draft-store';
import { useOrchestratorStream } from '@/components/desktop/thoughts/useOrchestratorStream';
import { ProfiledChatMessageList } from '@/components/desktop/thoughts/chat-panel/ProfiledChatMessageList';
import { resolveDisplayMessages } from '@/components/desktop/thoughts/chat-panel/resolve-display-messages';

const counts = vi.hoisted(() => ({
  messages: new Map<string, number>(), turns: new Map<string, number>(), lists: 0,
  socket: null as WebSocket | null,
}));
vi.mock('@/components/desktop/hooks/DesktopWebSocketContext', () => ({ useSharedDesktopWs: () => undefined }));
vi.mock('@/components/desktop/onboarding/useRuntimeInventory', () => ({
  useRuntimeInventory: () => ({ inventory: [], loading: false, error: null, refresh: () => {} }),
}));
vi.mock('@/components/desktop/thoughts/use-orchestrator-stream/shared', async original => ({
  ...await original<typeof import('@/components/desktop/thoughts/use-orchestrator-stream/shared')>(),
  openOrchestratorWebSocket: () => counts.socket,
}));
// Count leaf renders without making markdown parsing part of a timing assertion.
vi.mock('@/components/desktop/DesktopAgentMessage', () => ({
  DesktopAgentMessage: ({ entry }: { entry: MobileTranscriptEntry }) => {
    counts.messages.set(entry.id, (counts.messages.get(entry.id) ?? 0) + 1);
    return createElement('span', null, entry.text);
  },
}));
vi.mock('@/components/desktop/transcript/TranscriptNavigator', async original => {
  const actual = await original<typeof import('@/components/desktop/transcript/TranscriptNavigator')>();
  return { TranscriptNavigator: (props: Parameters<typeof actual.TranscriptNavigator>[0]) => {
    counts.lists += 1;
    return createElement(actual.TranscriptNavigator, props);
  } };
});
vi.mock('@/components/desktop/transcript/turns', async original => {
  const actual = await original<typeof import('@/components/desktop/transcript/turns')>();
  return { ...actual, transcriptTurnFiles: (entries: MobileTranscriptEntry[]) => {
    const id = entries[0]?.id;
    if (id && id !== 'u299') counts.turns.set(id, (counts.turns.get(id) ?? 0) + 1);
    return actual.transcriptTurnFiles(entries);
  } };
});

const repoPath = '/synthetic/streaming-transcript';
const threadId = 'thoughts-render-counts';
const entries: MobileTranscriptEntry[] = Array.from({ length: 300 }, (_, i) => [
  { id: `u${i}`, role: 'user' as const, text: `Request ${i}`, timestamp: i * 1000 },
  { id: `a${i}`, role: 'assistant' as const, text: `Answer ${i}`, timestamp: i * 1000 + 1 },
]).flat();
entries.splice(1, 0, ...['tool-one', 'tool-two'].map(id => ({
  id, role: 'assistant' as const, text: '',
  toolCalls: [{ id, name: 'Read', status: 'done' as const, args: { file_path: 'src/fixture.ts' } }],
})));
let root: Root;
let host: HTMLDivElement;
let nextFrame: number;
let frames: Map<number, FrameRequestCallback>;
const panelRef = createRef<ThoughtsChatPanelHandle>();
const historyEntries = entries.slice(0, -2);
const liveEntries = entries.slice(-2);
const noMessages: MobileTranscriptEntry[] = [];

function StreamingTranscript() {
  const stream = useOrchestratorStream(repoPath, { threadId });
  const { replaceTranscript } = stream;
  useEffect(() => replaceTranscript(liveEntries), [replaceTranscript]);
  const messages = useMemo(() => resolveDisplayMessages({
    historyEntries, chatMessages: noMessages, streamMessages: stream.messages,
  }), [stream.messages]);
  return createElement(ProfiledChatMessageList, {
    displayMessages: messages, displayWaiting: stream.status === 'busy',
    activeTargetLabel: 'Codex', activeTargetColor: 'var(--t-accent)',
    thoughtsMutedGlass: 'var(--t-panel)', thoughtsElevatedBorder: 'var(--t-border)',
    thoughtsElevatedShadow: 'none', emptyStateFallback: null,
  });
}
async function mountStream() {
  await act(async () => root.render(createElement(StreamingTranscript)));
  await emit('status', { status: 'ready', snapshot: true });
  await frame(); await frame();
  expect(host.querySelectorAll('[data-o8-message-id]')).toHaveLength(600);
  resetCounts();
}

async function emit(event: string, data: Record<string, unknown>) {
  await act(async () => counts.socket!.onmessage?.({ data: JSON.stringify({
    channel: 'orchestrator', event, data: { threadId, backend: 'codex', ...data },
  }) } as MessageEvent));
}
async function frame() {
  const pending = [...frames.values()];
  frames.clear();
  await act(async () => pending.forEach(callback => callback(0)));
}
function resetCounts() { counts.messages.clear(); counts.turns.clear(); counts.lists = 0; }
function completedMessageRenders() {
  return [...counts.messages].filter(([id]) => id !== 'u299' && id !== 'a299').reduce((sum, [, count]) => sum + count, 0);
}

beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear(); resetComposerDraftMemoryForTests();
  nextFrame = 0; frames = new Map(); resetCounts();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrame; frames.set(id, callback); return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  counts.socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url);
    if (path.startsWith('/api/v2/chat-history?')) return Response.json({ messages: serializeTranscriptForStorage(entries), repoPath, backend: 'codex' });
    if (path.includes('composer-queue')) return Response.json({ items: [], canSteer: true, steerableIds: [] });
    if (path.includes('operator-defaults')) return Response.json({ orchestratorBackend: 'codex', orchestratorModel: 'fixture-model' });
    return Response.json({ agents: [], conversations: [] });
  }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
async function mountPanel() {
  await act(async () => root.render(createElement(ThoughtsChatPanel, {
    ref: panelRef, open: true, agents: [], sessionTargets: [], workspaceTargets: [],
    repoPath, scopeTabId: 'render-fixture', initialMode: 'fleet', preferredRuntime: 'codex',
    missionState: { version: 2, prompt: '', summary: '', packets: [], updatedAt: new Date(0).toISOString() },
    suppressAutoRestore: true, suppressRuntimePrewarm: true,
    thoughtsBodyBackground: 'var(--t-bg)', thoughtsElevatedSurface: 'var(--t-panel)',
    thoughtsElevatedBorder: 'var(--t-border)', thoughtsElevatedShadow: 'none', thoughtsMutedGlass: 'var(--t-muted)',
    onMissionStateChange: () => {}, onChromeChange: () => {},
  })));
  await act(async () => panelRef.current!.loadThread(threadId));
  await emit('status', { status: 'ready', snapshot: true });
  await frame(); await frame();
  expect(host.querySelector('[data-o8-message-id="a299"]')).not.toBeNull();
  resetCounts();
}
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); counts.socket = null;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  localStorage.clear(); sessionStorage.clear(); resetComposerDraftMemoryForTests();
});

it('reuses all 299 completed turns during 200 updates to the last of 300 turns', async () => {
  await mountStream();
  await emit('output', { assistantMessageId: 'a299', text: 'Start' }); await frame(); await frame();
  resetCounts();
  for (let i = 0; i < 200; i += 1) {
    await emit('output', { assistantMessageId: 'a299', text: `chunk${i}` });
    if (i % 10 === 9) await frame();
  }
  const completedTurns = [...counts.turns.values()].reduce((sum, count) => sum + count, 0);
  console.info('[stream-render] updates=200 frames=20 completed-turn-renders=%d completed-message-renders=%d active-answer-renders=%d',
    completedTurns, completedMessageRenders(), counts.messages.get('a299') ?? 0);
  expect(host.querySelector('[data-o8-message-id="a299"]')!.textContent).toBe(['Start', ...Array.from({ length: 200 }, (_, i) => `chunk${i}`)].join('\n'));
  expect(completedTurns).toBe(0);
  expect(completedMessageRenders()).toBe(0);
  expect(counts.messages.get('a299')).toBe(20);
});

it('commits a burst of 200 socket deltas only once on the next frame and retains the terminal tail', async () => {
  await mountStream();
  await emit('output', { assistantMessageId: 'a299', text: 'Start' }); await frame(); await frame();
  resetCounts();
  for (let i = 0; i < 200; i += 1) await emit('output', { assistantMessageId: 'a299', text: 'delta' });
  expect(counts.lists).toBe(0);
  await frame();
  console.info('[stream-frame] updates=200 frames=1 transcript-renders=%d', counts.lists);
  expect(counts.lists).toBe(1);
  await emit('output', { assistantMessageId: 'a299', text: 'Tail' });
  await emit('status', { status: 'ready' });
  expect(host.querySelector('[data-o8-message-id="a299"]')!.textContent).toBe(['Start', ...Array<string>(200).fill('delta'), 'Tail'].join('\n'));
  const settled = counts.lists;
  await frame();
  expect(counts.lists).toBe(settled);
});

it('keeps 20 real composer keystrokes out of transcript rendering', async () => {
  await mountPanel();
  const input = host.querySelector<HTMLTextAreaElement>('textarea')!;
  for (let i = 1; i <= 20; i += 1) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'x'.repeat(i));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  console.info('[composer-render] keystrokes=20 transcript-renders=%d message-renders=%d',
    counts.lists, [...counts.messages.values()].reduce((sum, count) => sum + count, 0));
  expect(input.value).toBe('x'.repeat(20));
  expect(counts.lists).toBe(0);
  expect(counts.messages.size).toBe(0);
});
