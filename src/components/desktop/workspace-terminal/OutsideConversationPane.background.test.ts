// @vitest-environment jsdom
import { act, createElement, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { transcriptStore } from '@/lib/transcripts/store';
import { OutsideConversationPane } from './OutsideConversationPane';
import type { TerminalTab } from './types';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

const keys = ['codex-discovered:background-one', 'codex-discovered:background-two'];
let host: HTMLDivElement;
let root: Root;
let commits = 0;
let documentHidden = false;
const entry = (text: string): MobileTranscriptEntry => ({ id: 'reply', role: 'assistant', text, timestamp: 1 });
function publish(text: string, key = keys[0], extra: Partial<MobileTranscriptEntry> = {}) {
  transcriptStore.setSlice(key, { status: 'fresh', lastUpdated: 1, messages: [{ ...entry(text), ...extra }] });
}
async function render(active: boolean, key = keys[0]) {
  await act(async () => root.render(createElement(Profiler, { id: 'outside', onRender: () => { commits++; } },
    createElement(OutsideConversationPane, { sessionKey: key, runtime: 'codex', active,
      tab: { id: key, kind: 'chat', label: 'Fixture conversation' } as TerminalTab }))));
}
async function advance(ms: number) { await act(async () => vi.advanceTimersByTime(ms)); }
beforeEach(() => {
  vi.useFakeTimers();
  documentHidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => documentHidden);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json({
    transcript: transcriptStore.getSlice(new URL(url, 'http://localhost').searchParams.get('sessionKey')).messages,
  })));
  for (const key of keys) { transcriptStore.clear(key); publish(`Initial ${key}`, key); }
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  commits = 0;
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  for (const key of keys) transcriptStore.clear(key);
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
it('bounds hidden shared-cache text commits while retaining the latest output', async () => {
  await render(false); commits = 0;
  for (let tick = 0; tick < 10; tick++) {
    await act(async () => publish(`Stream tick ${tick}`));
    await advance(50);
  }
  expect(host.textContent).toContain(`Initial ${keys[0]}`);
  expect(commits).toBe(0);
  expect(transcriptStore.getSlice(keys[0]).messages[0].text).toBe('Stream tick 9');
  await advance(500);
  expect(host.textContent).toContain('Stream tick 9');
  expect(commits).toBe(1);
});
it('catches up immediately on reveal without replacing the transcript node', async () => {
  await render(false);
  const article = host.querySelector('article');
  await act(async () => publish('Pending hidden tail'));
  await advance(100);
  expect(host.textContent).not.toContain('Pending hidden tail');
  await render(true);
  expect(host.textContent).toContain('Pending hidden tail');
  expect(host.querySelector('article')).toBe(article);
});
it('keeps visible shared-cache updates immediate', async () => {
  await render(true);
  await act(async () => publish('Visible output'));
  expect(host.textContent).toContain('Visible output');
});
it('coalesces a selected pane in a hidden document and catches up on visibility without remounting', async () => {
  await render(true);
  const article = host.querySelector('article');
  documentHidden = true;
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  commits = 0;
  for (let tick = 0; tick < 10; tick++) {
    await act(async () => publish(`Window tick ${tick}`)); await advance(50);
  }
  expect(commits).toBe(0);
  expect(transcriptStore.getSlice(keys[0]).messages[0].text).toBe('Window tick 9');
  await advance(500);
  expect(host.textContent).toContain('Window tick 9');
  expect(commits).toBe(1);
  await act(async () => publish('Pending window tail'));
  expect(host.textContent).not.toContain('Pending window tail');
  documentHidden = false;
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(host.textContent).toContain('Pending window tail');
  expect(host.querySelector('article')).toBe(article);
  commits = 0; await advance(1000); expect(commits).toBe(0);
});
it.each([false, true])('presents a hidden question immediately (selected=%s) and cancels older pending text', async (active) => {
  documentHidden = active;
  await render(active);
  await act(async () => publish('Pending prose'));
  await act(async () => publish('Question output', keys[0], {
    toolCalls: [{ name: 'AskUserQuestion', args: { question: 'Continue?' }, status: 'running' }],
  }));
  expect(host.textContent).toContain('Continue?');
  expect(host.textContent).toContain('Question output');
  await advance(1000);
  expect(host.textContent).not.toContain('Pending prose');
});
it.each([false, true])('presents hidden errors immediately (selected=%s) without reverting after the old deadline', async (active) => {
  documentHidden = active;
  await render(active);
  await act(async () => publish('Pending prose'));
  await act(async () => transcriptStore.setStatus(keys[0], 'error', 'Fixture error'));
  expect(host.textContent).toContain('Transcript unavailable');
  await advance(1000);
  expect(host.textContent).toContain('Transcript unavailable');
});
it.each([false, true])('presents a new hidden turn immediately (selected=%s) instead of delaying it with earlier prose', async (active) => {
  documentHidden = active;
  await render(active);
  await act(async () => publish('Pending prose'));
  await act(async () => transcriptStore.mergeEntries(keys[0], [{ ...entry('New turn'), id: 'new-turn' }]));
  expect(host.textContent).toContain('Pending prose');
  expect(host.textContent).toContain('New turn');
  await advance(1000);
  expect(host.textContent).toContain('New turn');
});
it('isolates source changes and cancels queued commits on unmount', async () => {
  await render(false);
  await act(async () => publish('Old source tail'));
  await render(false, keys[1]);
  expect(host.textContent).toContain(`Initial ${keys[1]}`);
  await advance(1000);
  expect(host.textContent).not.toContain('Old source tail');
  await act(async () => publish('Second pending tail', keys[1]));
  await act(async () => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  root = createRoot(host);
});
