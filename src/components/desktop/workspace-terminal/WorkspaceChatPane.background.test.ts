// @vitest-environment jsdom
import { act, createElement, Profiler, type ChangeEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { transcriptStore } from '@/lib/transcripts/store';
import { useWorkspaceChatPane } from './useWorkspaceChatPane';
import { WorkspaceTranscript } from './WorkspaceTranscript';
import { resetWorkspaceChatDraftStatesForTests } from './workspace-chat-drafts';
import { resetWorkspaceSteerQueueForTests } from './workspace-chat-queue';
import type { TerminalTab } from './types';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

const keys = ['muse-owned:background-one', 'muse-owned:background-two'];
const callbacks = { onUpdateMessages: vi.fn(), onUpdateSessionKey: vi.fn(), onSelectModel: vi.fn(), onConsumeDraftInjection: vi.fn() };
let root: Root; let host: HTMLDivElement; let commits = 0;
let documentHidden = false;
function publish(text: string, key = keys[0], extra: Partial<MobileTranscriptEntry> = {}) {
  transcriptStore.setSlice(key, { status: 'fresh', lastUpdated: 1,
    messages: [{ id: 'reply', role: 'assistant', text, timestamp: 1, ...extra }] });
}
function Pane({ active, sessionKey }: { active: boolean; sessionKey: string }) {
  const chat = useWorkspaceChatPane({ tab: { id: sessionKey, kind: 'chat', chatRuntime: 'muse', chatSessionKey: sessionKey } as TerminalTab, active, ...callbacks });
  return createElement('div', null,
    createElement(WorkspaceTranscript, { entries: chat.visibleTranscriptEntries, active }),
    createElement('textarea', { value: chat.draft, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => chat.setDraft(event.currentTarget.value) }));
}
async function render(active: boolean, sessionKey = keys[0]) {
  await act(async () => root.render(createElement(Profiler, { id: 'workspace', onRender: () => { commits++; } },
    createElement(Pane, { active, sessionKey }))));
}
async function advance(ms: number) { await act(async () => vi.advanceTimersByTime(ms)); }
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  documentHidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => documentHidden);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ agents: [], entries: [], transcript: [] })));
  for (const key of keys) { transcriptStore.clear(key); publish(`Initial ${key}`, key); }
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); commits = 0;
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  for (const key of keys) transcriptStore.clear(key);
  resetWorkspaceChatDraftStatesForTests(); resetWorkspaceSteerQueueForTests();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
it('coalesces hidden workspace text without stopping shared-cache delivery', async () => {
  await render(false); commits = 0;
  for (let tick = 0; tick < 10; tick++) {
    await act(async () => publish(`Stream tick ${tick}`)); await advance(50);
  }
  expect(transcriptStore.getSlice(keys[0]).messages[0].text).toBe('Stream tick 9');
  expect(host.textContent).toContain(`Initial ${keys[0]}`); expect(commits).toBe(0);
  await advance(500);
  expect(host.textContent).toContain('Stream tick 9');
});
it('reveals the current workspace tail immediately and retains the transcript node', async () => {
  await render(false); const original = host.querySelector('[data-o8-message-id="reply"]');
  await act(async () => publish('Pending hidden text')); await advance(100);
  expect(host.textContent).not.toContain('Pending hidden text');
  await render(true);
  expect(host.textContent).toContain('Pending hidden text');
  expect(host.querySelector('[data-o8-message-id="reply"]')).toBe(original);
});
it('keeps visible workspace text immediate', async () => {
  await render(true); await act(async () => publish('Visible text'));
  expect(host.textContent).toContain('Visible text');
});
it('slows a selected workspace in an initially hidden document and resumes without replacing its draft', async () => {
  documentHidden = true;
  await render(true);
  const original = host.querySelector('[data-o8-message-id="reply"]');
  const draft = host.querySelector('textarea');
  commits = 0;
  for (let tick = 0; tick < 10; tick++) {
    await act(async () => publish(`Window tick ${tick}`)); await advance(50);
  }
  expect(commits).toBe(0);
  expect(transcriptStore.getSlice(keys[0]).messages[0].text).toBe('Window tick 9');
  await advance(500);
  expect(host.textContent).toContain('Window tick 9');
  await act(async () => publish('Pending window tail'));
  expect(host.textContent).not.toContain('Pending window tail');
  documentHidden = false;
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(host.textContent).toContain('Pending window tail');
  expect(host.querySelector('[data-o8-message-id="reply"]')).toBe(original);
  expect(host.querySelector('textarea')).toBe(draft);
  commits = 0; await advance(1000); expect(commits).toBe(0);
});
it.each([false, true])('presents hidden tool metadata immediately (selected=%s) and cancels the older prose deadline', async (active) => {
  documentHidden = active;
  await render(active); await act(async () => publish('Pending prose'));
  await act(async () => publish('Question text', keys[0], { toolCalls: [{ name: 'AskUserQuestion', args: { question: 'Continue?' }, status: 'running' }] }));
  expect(host.textContent).toContain('Question text'); expect(host.textContent).toContain('Work details');
  commits = 0; await advance(1000); expect(commits).toBe(0);
});
it.each([false, true])('observes hidden error state immediately (selected=%s) and cancels pending text notification', async (active) => {
  documentHidden = active;
  await render(active); await act(async () => publish('Pending prose')); commits = 0;
  await act(async () => transcriptStore.setStatus(keys[0], 'error', 'Fixture error'));
  expect(commits).toBeGreaterThan(0); commits = 0; await advance(1000); expect(commits).toBe(0);
});
it.each([false, true])('presents new turns immediately (selected=%s)', async (active) => {
  documentHidden = active;
  await render(active); await act(async () => publish('Pending prose'));
  await act(async () => transcriptStore.mergeEntries(keys[0], [{ id: 'new-turn', role: 'user', text: 'New turn', timestamp: 2 }]));
  expect(host.textContent).toContain('New turn');
});
it('isolates changed workspace sources and cancels the queued presentation on unmount', async () => {
  await render(false); await act(async () => publish('Old source tail'));
  await render(false, keys[1]); await advance(1000);
  expect(host.textContent).toContain(`Initial ${keys[1]}`); expect(host.textContent).not.toContain('Old source tail');
  await act(async () => publish('Second pending tail', keys[1]));
  await act(async () => root.unmount()); expect(vi.getTimerCount()).toBe(0);
  root = createRoot(host);
});
