// @vitest-environment jsdom

import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DesktopWebSocketProvider, useSharedDesktopWs } from '@/components/desktop/hooks/DesktopWebSocketContext';
import { WorkspaceTranscript } from '@/components/desktop/workspace-terminal/WorkspaceTranscript';
import { transcriptStore } from '@/lib/transcripts/store';
import { useTranscript } from '@/lib/transcripts/useTranscript';
import { buildTranscriptWsCallbacks } from '@/lib/transcripts/wireWsBridge';
import { TranscriptNavigator } from '@/components/desktop/transcript/TranscriptNavigator';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

const extras = vi.hoisted(() => new Map<string, number>());
vi.mock('@/components/desktop/workspace-terminal/chat-renderers/WorkspaceTranscriptEventExtras', async original => {
  const actual = await original<typeof import('@/components/desktop/workspace-terminal/chat-renderers/WorkspaceTranscriptEventExtras')>();
  return { WorkspaceTranscriptEventExtras: (props: Parameters<typeof actual.WorkspaceTranscriptEventExtras>[0]) => {
    extras.set(props.entry.id, (extras.get(props.entry.id) ?? 0) + 1);
    return createElement(actual.WorkspaceTranscriptEventExtras, props);
  } };
});
const markdown = vi.hoisted(() => new Map<string, number>());
vi.mock('@/components/desktop/LLMMarkdown', async original => {
  const actual = await original<typeof import('@/components/desktop/LLMMarkdown')>();
  return { ...actual, renderLLMMarkdown: (...args: Parameters<typeof actual.renderLLMMarkdown>) => {
    markdown.set(args[0], (markdown.get(args[0]) ?? 0) + 1);
    return actual.renderLLMMarkdown(...args);
  } };
});
vi.mock('@/lib/panel/ws-port-client', () => ({ getBrowserWsPort: () => 0 }));
class FixtureSocket {
  static OPEN = 1;
  static instances: FixtureSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  send() {}
  close() { this.readyState = 3; }
  constructor() { FixtureSocket.instances.push(this); }
}
const sessionKey = 'codex-owned:main-thread-fixture';
const callbacks = buildTranscriptWsCallbacks();
const entries: MobileTranscriptEntry[] = Array.from({ length: 300 }, (_, index) => ({
  id: `message-${index}`, role: index % 2 ? 'assistant' : 'user', timestamp: 1700000000000 + index * 1000,
  text: index % 2 ? `Response ${index}.\n\nA completed answer.\n\n\`\`\`typescript\nconst sequence = ${index};\n\`\`\`` : `Request ${index}`,
}));
entries[101] = { ...entries[101], toolCalls: [{ id: 'read-fixture', name: 'Read', args: { file_path: 'fixture.ts' }, status: 'done' }] };
const scrollRef = createRef<HTMLDivElement>();
function Transcript() {
  useSharedDesktopWs(undefined, callbacks);
  const slice = useTranscript(sessionKey);
  return createElement('div', null,
    createElement(TranscriptNavigator, { entries: slice.messages, scrollRef }),
    createElement('div', { ref: scrollRef }, createElement(WorkspaceTranscript, { entries: slice.messages })));
}
let host: HTMLDivElement;
let root: Root;
let seq: number;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let resizeCallbacks: Array<() => void>;
async function frame() {
  const pending = [...frames.values()]; frames.clear();
  await act(async () => pending.forEach(callback => callback(0)));
}
async function snapshot(messages = entries, present = true) {
  await act(async () => FixtureSocket.instances[0].onmessage?.({ data: JSON.stringify({
    channel: 'realtime', event: 'batch', data: { events: [{
      stream: `session:${sessionKey}`, seq: ++seq, channel: 'history', event: 'history.snapshot',
      data: { sessionKey, entries: messages, replace: true },
    }] },
  }) } as MessageEvent));
  if (present) await act(async () => { vi.advanceTimersByTime(250); });
}
beforeEach(async () => {
  vi.useFakeTimers();
  seq = 0; markdown.clear(); extras.clear(); FixtureSocket.instances = [];
  frameId = 0; frames = new Map(); resizeCallbacks = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(4000);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('WebSocket', FixtureSocket);
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resizeCallbacks.push(callback); } observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ references: [] })));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(DesktopWebSocketProvider, null, createElement(Transcript))));
  await act(async () => { FixtureSocket.instances[0].readyState = 1; FixtureSocket.instances[0].onopen?.(); });
  await snapshot(); await frame(); markdown.clear(); extras.clear();
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); transcriptStore.clear(sessionKey);
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
it('does not parse completed markdown or reformat completed timestamps for each streaming snapshot', async () => {
  const time = vi.spyOn(Date.prototype, 'toLocaleTimeString');
  const tooltip = vi.spyOn(Date.prototype, 'toLocaleString');
  const retained = transcriptStore.getSlice(sessionKey).messages;
  for (let index = 0; index < 20; index++) await snapshot([
    ...entries.slice(0, -1), { ...entries.at(-1)!, text: `${entries.at(-1)!.text}\nStreaming sample ${index}.` },
  ]);
  const completed = [...markdown].filter(([text]) => !text.includes('Streaming sample')).reduce((sum, [, count]) => sum + count, 0);
  console.info('[worker-stream] snapshots=20 completed-markdown=%d timestamp-formats=%d', completed, time.mock.calls.length + tooltip.mock.calls.length);
  expect(host.querySelectorAll('[data-o8-message-id]')).toHaveLength(200);
  expect(host.querySelector('[data-o8-message-id="message-299"]')?.textContent).toContain('Streaming sample 19.');
  expect(completed).toBe(0);
  expect(time.mock.calls.length + tooltip.mock.calls.length).toBeLessThanOrEqual(40);
  expect(transcriptStore.getSlice(sessionKey).messages[0]).toBe(retained[0]);
});
it('does no markdown work for an identical replacement, while preserving replacement order and edits', async () => {
  await snapshot();
  console.info('[worker-identical] markdown-parses=%d', [...markdown.values()].reduce((sum, count) => sum + count, 0));
  expect(markdown.size).toBe(0);
  const reordered = entries.slice(-200).reverse();
  reordered[0] = { ...reordered[0], text: 'Edited **answer**' };
  await snapshot(reordered);
  expect([...host.querySelectorAll('[data-o8-message-id]')].map(node => node.getAttribute('data-o8-message-id'))).toEqual(reordered.map(entry => entry.id));
  expect(host.querySelector('strong')?.textContent).toBe('answer');
  await snapshot([]);
  expect(host.querySelectorAll('[data-o8-message-id]')).toHaveLength(0);
});
it('shares only equal snapshot entries and delivers nested metadata changes and removals', async () => {
  const messages = entries.slice(-200);
  messages[0] = { ...messages[0], sources: [{ title: 'Original source', path: 'original.ts' }], tokens: { input: 1, output: 2 } };
  await snapshot(messages);
  const original = transcriptStore.getSlice(sessionKey).messages;
  await snapshot(messages);
  expect(transcriptStore.getSlice(sessionKey).messages === original).toBe(true);
  const changed = [...messages];
  changed[0] = { ...changed[0], sources: [{ title: 'Updated source', path: 'updated.ts' }], tokens: { input: 1, output: 3 } };
  await snapshot(changed);
  const updated = transcriptStore.getSlice(sessionKey).messages;
  expect(updated).toEqual(changed);
  expect(updated[0]).not.toBe(original[0]);
  expect(updated[1]).toBe(original[1]);
  changed[0] = entries[100];
  await snapshot(changed);
  expect(transcriptStore.getSlice(sessionKey).messages[0].sources).toBeUndefined();
});
it('does not rebuild timestamp formats when the streaming answer keeps its timestamp', async () => {
  const time = vi.spyOn(Date.prototype, 'toLocaleTimeString');
  const tooltip = vi.spyOn(Date.prototype, 'toLocaleString');
  for (let index = 0; index < 20; index++) await snapshot([
    ...entries.slice(0, -1), { ...entries.at(-1)!, text: `Answer chunk ${index}` },
  ]);
  console.info('[worker-time] snapshots=20 timestamp-formats=%d', time.mock.calls.length + tooltip.mock.calls.length);
  expect(time.mock.calls.length).toBe(0);
  expect(tooltip.mock.calls.length).toBe(0);
  const edited = [...entries];
  edited[299] = { ...edited[299], timestamp: 1700001000000 };
  await snapshot(edited);
  expect(host.querySelector('[data-o8-message-id="message-299"] time')?.getAttribute('dateTime')).toBe(new Date(1700001000000).toISOString());
  expect(time).toHaveBeenCalledTimes(1);
  expect(tooltip).toHaveBeenCalledTimes(1);
});

it('keeps completed worker row subtrees out of streaming reconciliation', async () => {
  for (let index = 0; index < 20; index++) await snapshot([
    ...entries.slice(0, -1), { ...entries.at(-1)!, text: `Answer chunk ${index}` },
  ]);
  const completed = [...extras].filter(([id]) => id !== 'message-299').reduce((sum, [, count]) => sum + count, 0);
  console.info('[worker-row] snapshots=20 completed-row-renders=%d active-row-renders=%d', completed, extras.get('message-299'));
  expect(completed).toBe(0);
  expect(extras.get('message-299')).toBe(20);
});

it('keeps navigator geometry observers stable while answer previews update', async () => {
  const reads = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
  const observersBefore = resizeCallbacks.length;
  for (let index = 0; index < 20; index++) {
    await snapshot([...entries.slice(0, -1), { ...entries.at(-1)!, text: `Answer chunk ${index}` }]);
    await frame();
  }
  console.info('[worker-navigator] snapshots=20 geometry-reads=%d observer-restarts=%d', reads.mock.calls.length, resizeCallbacks.length - observersBefore);
  expect(reads.mock.calls.length).toBe(0);
  expect(resizeCallbacks.length).toBe(observersBefore);
  expect(host.querySelectorAll('nav button')).toHaveLength(100);
  // Size and scroll changes still request fresh geometry through the same observer.
  await act(async () => resizeCallbacks.at(-1)!()); await frame();
  expect(reads.mock.calls.length).toBeGreaterThan(0);
  const edited = [...entries.slice(0, -1), { ...entries.at(-1)!, text: 'Answer chunk 19' }];
  edited[100] = { ...edited[100], text: 'Revised prompt' };
  const beforeEdit = resizeCallbacks.length;
  await snapshot(edited); await frame();
  expect(resizeCallbacks.length).toBeGreaterThan(beforeEdit);
  const last = [...host.querySelectorAll('nav button')].at(-1)!;
  await act(async () => {
    last.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(230);
  });
  expect(document.querySelector('[data-transcript-peek]')?.textContent).toContain('Answer chunk 19');
});

it('coalesces an edit burst, retains the cached tail and flushes message boundaries immediately', async () => {
  for (let index = 0; index < 200; index++) await snapshot([
    ...entries.slice(0, -1), { ...entries.at(-1)!, text: `Answer chunk ${index}` },
  ], false);
  await act(async () => root.render(createElement(DesktopWebSocketProvider, null, createElement(Transcript))));
  const before = extras.get('message-299') ?? 0;
  expect(transcriptStore.getSlice(sessionKey).messages.at(-1)?.text).toBe('Answer chunk 199');
  console.info('[worker-present] updates=200 commits-before-window=%d', before);
  expect(before).toBe(0);
  await act(async () => { vi.advanceTimersByTime(249); });
  expect(extras.get('message-299') ?? 0).toBe(0);
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(extras.get('message-299')).toBe(1);
  expect(host.querySelector('[data-o8-message-id="message-299"]')?.textContent).toContain('Answer chunk 199');
  await snapshot([...entries.slice(0, -1), { ...entries.at(-1)!, text: 'Final tail' }], false);
  await snapshot([...entries.slice(0, -1), { ...entries.at(-1)!, text: 'Final tail' }, { id: 'next-user', role: 'user', text: 'Next request' }], false);
  expect(host.querySelector('[data-o8-message-id="message-299"]')?.textContent).toContain('Final tail');
  expect(host.querySelector('[data-o8-message-id="next-user"]')).not.toBeNull();
  await snapshot([], false);
  await act(async () => { vi.advanceTimersByTime(250); });
  expect(host.querySelectorAll('[data-o8-message-id]')).toHaveLength(0);
});
