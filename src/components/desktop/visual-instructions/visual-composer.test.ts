// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VisualInstructionDraft } from '@/lib/composer/visual-draft-store';
import { claimVisualCapture, releaseVisualCapture } from '@/lib/composer/visual-capture-state';
const test = vi.hoisted(() => ({ principal: 'a', rows: new Map<string, VisualInstructionDraft>(), listeners: new Set<() => void>(), hold: null as Promise<void> | null }));
vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => ({ user: { id: test.principal }, isLoaded: true }) }));
vi.mock('@/lib/tauri/bridge', () => ({ canUseTauriEvents: () => false, isTauri: () => false }));
vi.mock('@/components/desktop/thoughts/InputButtons', () => ({
  InputButtons: ({ inlineLeadingExtras }: { inlineLeadingExtras?: React.ReactNode }) => React.createElement('div', null, inlineLeadingExtras), RepoTargetChip: () => null,
}));
vi.mock('@/components/desktop/thoughts/chat-panel/SlashCommandPicker', () => ({ SlashCommandPicker: () => null }));
vi.mock('@/components/desktop/thoughts/chat-panel/ComposerStatusBar', () => ({ ComposerStatusBar: () => null }));
vi.mock('./VisualInstructionClarification', () => ({ VisualInstructionClarification: () => null }));
vi.mock('@/lib/composer/visual-draft-store', () => ({
  readVisualDraft: (principal: string) => test.rows.get(principal) ?? null,
  subscribeVisualDrafts: (listener: () => void) => { test.listeners.add(listener); return () => test.listeners.delete(listener); },
  restoreVisualDraft: async () => {}, removeVisualDraft: async () => {},
  saveVisualDraft: async (draft: VisualInstructionDraft) => { test.rows.set(draft.principal, draft); test.listeners.forEach(listener => listener()); if (draft.status === 'saving') await test.hold; },
}));
const { VisualComposerArea } = await import('./VisualComposerArea');
const target = { threadId: 'thoughts-a', repoPath: '/project' };
const sample = (): VisualInstructionDraft => ({ principal: 'a', status: 'draft', template: {
  text: '[o8-visual-instruction]', wireMessage: '[o8-visual-instruction]', images: [],
  routing: { backend: 'codex', model: 'selected', effort: 'low', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false } },
  request: { version: 1, id: 'request-a', createdAt: '2026-10-19T12:00:00Z', target, utterance: 'Keep this button.',
    frames: [{ id: 'frame-a', atMs: 0, width: 80, height: 60, transcript: '', strokes: [], pins: [], image: { name: 'frame.png', dataUri: 'data:image/png;base64,iVBORw0KGgo=' } }] } });
let root: Root; let node: HTMLDivElement;
const fetcher = vi.fn<typeof fetch>();
const ordinarySend = vi.fn();
function mount() { root.render(React.createElement(VisualComposerArea, {
  visual: { active: true, target, label: 'current chat', capture: () => sample().template },
  activeComposer: true, showBrain: false, input: 'Unsent ordinary message', onInputChange: () => {}, isOrchestratorMode: true,
  displayWaiting: false, chatMessages: [], activeTargetLabel: 'Codex', targetAgentExists: true, thoughtsBodyBackground: 'var(--t-chat-surface-bg)',
  enhancing: false, preEnhanceInput: null, onEnhance: () => {}, onUndoEnhance: () => {}, onSubmit: ordinarySend, onSlashCommand: () => {},
  modelLabel: 'Codex', effort: 'low', onEffortChange: () => {}, adaptiveEnabled: false, displayMessagesCount: 0, hasAssistantActivity: false,
})); }
const send = () => node.querySelector<HTMLButtonElement>('[data-testid="composer-send-control"]')!;
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  test.principal = 'a'; test.rows.clear(); test.rows.set('a', sample()); test.hold = null; test.listeners.clear(); fetcher.mockReset();
  vi.stubGlobal('fetch', (url: RequestInfo | URL, options?: RequestInit) => options?.method === 'POST' ? fetcher(url, options) : Promise.resolve(Response.json({})));
  ordinarySend.mockClear(); localStorage.clear(); node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => mount());
});
afterEach(async () => { await act(async () => { releaseVisualCapture('capture'); root.unmount(); }); node.remove(); vi.unstubAllGlobals(); });
it('does not dispatch the old principal after a pending durable save', async () => {
  let release!: () => void; test.hold = new Promise<void>(done => { release = done; });
  await act(async () => send().click()); test.principal = 'b'; await act(async () => mount());
  await act(async () => release());
  expect(fetcher).not.toHaveBeenCalled(); expect(test.rows.get('a')?.status).toBe('draft');
  expect(test.rows.get('b')).toBeUndefined();
});
it('leaves a known rejected request editable with its actual frame retained', async () => {
  fetcher.mockResolvedValueOnce(Response.json({ error: 'Selected runtime unavailable.' }, { status: 400 }));
  await act(async () => send().click());
  expect(test.rows.get('a')).toMatchObject({ status: 'draft', error: 'Selected runtime unavailable.' });
  expect(node.querySelector<HTMLTextAreaElement>('textarea[aria-label="Visual instruction"]')?.disabled).toBe(false);
  expect(test.rows.get('a')?.request.frames).toHaveLength(1);
});
it('retains an ambiguous dispatch and only retries its original identity', async () => {
  fetcher.mockRejectedValueOnce(new Error('Response lost'));
  await act(async () => send().click());
  expect(test.rows.get('a')?.status).toBe('unknown'); expect(node.textContent).toContain('Check delivery');
  expect(node.querySelector<HTMLTextAreaElement>('textarea[aria-label="Visual instruction"]')?.disabled).toBe(true);
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).id).toBe('visual-request-a');
});
it('cannot send or clear a draft while its next frame is still recording or transcribing', async () => {
  await act(async () => claimVisualCapture('capture', 'a', target, 'request-a'));
  expect(send().disabled).toBe(true);
  expect(node.querySelector<HTMLButtonElement>('[aria-label="Discard visual draft"]')?.disabled).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});
it('uses one actual composer, preserves the ordinary draft on close, and resumes its marked draft', async () => {
  expect(node.querySelectorAll('textarea')).toHaveLength(1);
  expect(node.querySelector('textarea')?.value).toBe('Keep this button.');
  await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Close visual draft"]')?.click());
  expect(node.querySelectorAll('textarea')).toHaveLength(1);
  expect(node.querySelector('textarea')?.value).toBe('Unsent ordinary message');
  expect(test.rows.get('a')?.request.frames).toHaveLength(1);
  await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Resume visual instruction"]')?.click());
  expect(node.querySelector('textarea')?.value).toBe('Keep this button.');
  expect(ordinarySend).not.toHaveBeenCalled();
});
it('sends through the shared composer Enter path and returns to the preserved ordinary input only after acknowledgement', async () => {
  fetcher.mockResolvedValueOnce(Response.json({ item: { id: 'visual-request-a', threadId: target.threadId, repoPath: target.repoPath, status: 'queued' } }));
  await act(async () => node.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(fetcher).toHaveBeenCalledTimes(1); expect(ordinarySend).not.toHaveBeenCalled();
  expect(node.querySelectorAll('textarea')).toHaveLength(1);
  expect(node.querySelector('textarea')?.value).toBe('Unsent ordinary message');
  expect(test.rows.get('a')?.status).toBe('saved');
  expect(node.textContent).toContain('queued in this chat');
});
