// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { transcriptStore } from '@/lib/transcripts/store';
import { TranscriptSessionSubscriptionProvider } from '@/lib/transcripts/useTranscript';
import { WorkspaceChatPane } from './WorkspaceChatPane';
import { computeCliChatSession } from './terminal-session-ops';
import { buildPersistedState } from './terminal-tab-handlers';
import { computeRestoredTabs } from './terminal-restore';
import type { TerminalTab } from './types';
import { normalizeWorkspaceChatSessionKey } from './utils';

const writable = vi.hoisted(() => vi.fn(() => { throw new Error('Writable chat must not mount for an outside conversation'); }));
vi.mock('./useWorkspaceChatPane', () => ({ useWorkspaceChatPane: writable }));
let host: HTMLDivElement; let root: Root;
const keys = ['codex-discovered:outside-one', 'claude-code:outside-two', 'codex:outside-three', 'codex-live:outside-four'];
const subscribe = vi.fn((_key: string) => vi.fn());
const callbacks = { onUpdateMessages: vi.fn(), onUpdateSessionKey: vi.fn(), onSelectModel: vi.fn(), onConsumeDraftInjection: vi.fn(), onLinkedIssueChange: vi.fn(), onSaveCheckpoint: vi.fn(), onRestoreLatestCheckpoint: vi.fn() };
function tab(sessionKey: string): TerminalTab {
  return computeCliChatSession({ runtime: sessionKey.startsWith('codex') ? 'codex' : 'claude-code', targetSessionKey: sessionKey, label: 'Outside conversation', repo: { name: 'Fixture', localPath: '/fixture' }, initialText: 'Do not execute this', autoSend: true }, [], '').tabs[0];
}
async function render(current: TerminalTab, active = true) {
  const subscription = { subscribe, children: createElement(WorkspaceChatPane, { tab: current, active, ...callbacks }) };
  await act(async () => root.render(createElement(TranscriptSessionSubscriptionProvider, subscription)));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); writable.mockClear(); subscribe.mockClear();
  for (const callback of Object.values(callbacks)) callback.mockClear();
  for (const key of keys) transcriptStore.clear(key);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ transcript: [{ id: 'outside-entry', role: 'assistant', text: 'Original outside reply', timestamp: 1 }] })));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); for (const key of keys) transcriptStore.clear(key); vi.unstubAllGlobals(); });
it.each(keys)('reads %s without mounting any writable chat or consuming an auto-send injection', async key => {
  const current = tab(key); await render(current);
  expect(host.textContent).toContain('Read only'); expect(host.textContent).toContain(key);
  expect(host.textContent).toContain('Original outside reply'); expect(host.textContent).toContain('/fixture');
  expect(host.querySelector('textarea')).toBeNull(); expect(writable).not.toHaveBeenCalled();
  expect(callbacks.onConsumeDraftInjection).not.toHaveBeenCalled();
  expect(current.chatDraftInjection?.text).toBe('Do not execute this');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain(encodeURIComponent(key));
  expect(subscribe).toHaveBeenCalledWith(key);
});
it('follows exact-source transcript updates and unsubscribes when changing sources or hiding', async () => {
  await render(tab(keys[0])); const stopFirst = subscribe.mock.results[0].value;
  await act(async () => transcriptStore.mergeEntries(keys[0], [{ id: 'new', role: 'assistant', text: 'New outside output', timestamp: 2 }]));
  expect(host.textContent).toContain('New outside output');
  await render(tab(keys[1])); expect(stopFirst).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain('New outside output');
  const stopSecond = subscribe.mock.results[1].value;
  await render(tab(keys[1]), false); expect(stopSecond).toHaveBeenCalledTimes(1);
  expect(writable).not.toHaveBeenCalled();
});
it.each(keys)('restores the same read-only %s view through normal tab persistence', async key => {
  const current = tab(key); const saved = JSON.parse(JSON.stringify(buildPersistedState([current], current.id)));
  const restored = await computeRestoredTabs(saved, { preferredRepo: null, defaultTab: 'terminal', createDefaultChatTab: () => { throw new Error('Do not replace the outside source'); } }, undefined, 'optimistic');
  expect(normalizeWorkspaceChatSessionKey(restored?.tabs[0].chatRuntime, restored?.tabs[0].chatSessionKey)).toBe(key);
  await render(restored!.tabs[0]); expect(host.textContent).toContain('Read only'); expect(host.textContent).toContain(key);
  expect(writable).not.toHaveBeenCalled();
});
it('keeps the last transcript on a failed read and retries only that source', async () => {
  transcriptStore.mergeEntries(keys[0], [{ id: 'retained', role: 'assistant', text: 'Retained source output', timestamp: 1 }]);
  vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 503 }));
  await render(tab(keys[0])); expect(host.textContent).toContain('Retained source output');
  expect(host.textContent).toContain('unavailable');
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
  expect(host.textContent).toContain('Original outside reply'); expect(host.textContent).not.toContain('unavailable');
  expect(host.querySelector('time')?.getAttribute('dateTime')).toBeTruthy();
  expect(vi.mocked(fetch).mock.calls.every(call => String(call[0]).includes(encodeURIComponent(keys[0])))).toBe(true);
});

it.each(keys)('infers the outside source from %s without a stored runtime hint', async key => {
  const current = tab(key); delete current.chatRuntime;
  await render(current); expect(host.textContent).toContain(key); expect(writable).not.toHaveBeenCalled();
});
it.each(keys.flatMap(key => [false, true].map(failed => ({ key, failed }))))('preserves $key during validated restore; inventory failed: $failed', async ({ key, failed }) => {
  const current = tab(key); const saved = JSON.parse(JSON.stringify(buildPersistedState([current], current.id)));
  vi.mocked(fetch).mockImplementation(async input => {
    if (String(input).includes('/api/mobile/history')) return Response.json({ transcript: [] });
    if (failed) throw new Error('Discovery unavailable');
    return Response.json({ agents: [] });
  });
  const restored = await computeRestoredTabs(saved, { preferredRepo: null, defaultTab: 'terminal', createDefaultChatTab: () => { throw new Error('Preserve the source'); } }, undefined, 'validated');
  expect(normalizeWorkspaceChatSessionKey(restored?.tabs[0].chatRuntime, restored?.tabs[0].chatSessionKey)).toBe(key);
  await render(restored!.tabs[0]); expect(host.textContent).toContain('Read only'); expect(writable).not.toHaveBeenCalled();
});
it('renders specialized source text and details without active mutation controls', async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ transcript: [{ id: 'source-diff', role: 'system', text: '```diff\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n```', toolCalls: [{ name: 'fixture-tool', args: { command: 'do not run' }, result: 'Source tool output' }], claudeCodeEvents: [{ type: 'permission_request', id: 'request', toolName: 'Bash', toolInput: { command: 'do not run' } }] }] }));
  await render(tab(keys[0]));
  expect(host.textContent).toContain('file.txt');
  const activeMutations = Array.from(host.querySelectorAll('button')).filter(button => !button.disabled && /apply|allow|approve|run|retry delivery|initialize/i.test(button.textContent ?? ''));
  expect(activeMutations).toHaveLength(0);
  expect(vi.mocked(fetch).mock.calls.every(call => !call[1]?.method || call[1]?.method === 'GET')).toBe(true);
});
