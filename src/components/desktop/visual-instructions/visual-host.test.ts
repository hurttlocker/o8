// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { visualCaptureTargets, type VisualCaptureTarget } from '@/lib/composer/visual-capture-targets';
import { ownsVisualDraft } from '@/lib/composer/visual-capture-state';
import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';
import type { VisualInstructionDraft } from '@/lib/composer/visual-draft-store';
import type { DictationStartOptions } from '@/components/desktop/dictation/types';
const test = vi.hoisted(() => ({ principal: 'a',
  invoke: vi.fn(), restore: vi.fn(async () => {}), read: vi.fn((): VisualInstructionDraft | null => null), save: vi.fn(async () => {}),
  start: vi.fn(async (_options: DictationStartOptions) => {}), stop: vi.fn(async () => {}), cancel: vi.fn(),
  events: new Map<string, (value: { payload: unknown }) => void>(),
}));
vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => ({ user: { id: test.principal }, isLoaded: true }) }));
vi.mock('@/components/desktop/dictation/DictationHost', () => ({ useDictationHostOptional: () => ({ active: false }) }));
vi.mock('@/components/desktop/dictation/useDictation', () => ({ useDictation: () => ({ start: test.start, stopAndSubmit: test.stop, cancel: test.cancel, snapshot: { state: 'recording' } }) }));
vi.mock('@/lib/tauri/bridge', () => ({ canUseTauriEvents: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: test.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ emitTo: vi.fn(async () => {}) }));
vi.mock('@/lib/tauri/events', () => ({ subscribeTauriEvent: (name: string, receive: (value: { payload: unknown }) => void) => { test.events.set(name, receive); return () => { test.events.delete(name); }; } }));
vi.mock('@/lib/composer/visual-draft-store', () => ({ restoreVisualDraft: test.restore, readVisualDraft: test.read, saveVisualDraft: test.save }));
const { VisualInstructionHost } = await import('./VisualInstructionHost');
let root: Root; let node: HTMLDivElement; let unregister: (() => void)[] = [];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const payload = (wireMessage: string): ComposerQueuePayload => ({ text: wireMessage, wireMessage, images: [], routing: { backend: 'codex', model: 'selected-model', effort: 'low', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false } });
const target = (id: string, template: () => ComposerQueuePayload = vi.fn(() => payload(id))) => {
  const result = { principal: 'a', target: { threadId: id, repoPath: '/project' }, label: id, eligible: () => true, template } as VisualCaptureTarget;
  unregister.push(visualCaptureTargets.register(result)); return result;
};
async function request(value: VisualCaptureTarget) { await act(async () => { visualCaptureTargets.request(value); }); }
async function action(id: string, action: string) { await act(async () => { test.events.get('o8:visual-capture-action')?.({ payload: { id, action } }); }); }
const captureId = () => test.invoke.mock.calls.find(call => call[0] === 'o8_visual_capture_begin')![1].id as string;
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  test.principal = 'a'; vi.clearAllMocks(); test.events.clear();
  test.restore.mockResolvedValue(undefined); test.read.mockReturnValue(null);
  test.invoke.mockResolvedValue({ dataUri: 'data:image/png;base64,iVBORw0KGgo=', width: 80, height: 60, strokes: [] });
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => { root.render(React.createElement(VisualInstructionHost)); });
});
afterEach(async () => { await act(async () => root.unmount()); unregister.forEach(remove => remove()); unregister = []; node.remove(); });
it('freezes route settings before restoring a draft and locks that captured chat until transcription finishes', async () => {
  const restoring = deferred<void>(); test.restore.mockReturnValueOnce(restoring.promise);
  const snapshot = payload('first route');
  const template = vi.fn(() => snapshot); const a = target('chat-a', template);
  await request(a); expect(template).toHaveBeenCalledTimes(1);
  template.mockReturnValue(payload('other route'));
  await act(async () => restoring.resolve());
  expect(ownsVisualDraft('a', a.target)).toBe(true);
  const id = captureId(); await action(id, 'finish');
  expect(ownsVisualDraft('a', a.target)).toBe(true); expect(test.save).not.toHaveBeenCalled();
  await act(async () => test.start.mock.calls[0][0].onComplete('Keep these exact words.'));
  expect(test.save).toHaveBeenCalledWith(expect.objectContaining({ template: snapshot, request: expect.objectContaining({ target: a.target, utterance: 'Keep these exact words.' }) }));
  expect(ownsVisualDraft('a', a.target)).toBe(false);
});
it('a cancelled startup cannot cancel the next capture or stop its recorder', async () => {
  const first = deferred<unknown>(); test.invoke.mockImplementationOnce(() => first.promise);
  const a = target('chat-a'); await request(a); const id = captureId(); await action(id, 'cancel');
  const b = target('chat-b'); await request(b); expect(ownsVisualDraft('a', b.target)).toBe(true);
  const cancelled = test.cancel.mock.calls.length;
  await act(async () => first.resolve(undefined));
  expect(test.cancel).toHaveBeenCalledTimes(cancelled); expect(test.stop).not.toHaveBeenCalled();
  expect(ownsVisualDraft('a', b.target)).toBe(true); expect(test.start).toHaveBeenCalledTimes(1);
});
it('account change while native finish is pending never saves pixels or stops the next owner', async () => {
  const finishing = deferred<unknown>(); const a = target('chat-a'); await request(a); const id = captureId();
  test.invoke.mockImplementationOnce(() => finishing.promise); await action(id, 'finish');
  test.principal = 'b'; await act(async () => root.render(React.createElement(VisualInstructionHost)));
  await act(async () => finishing.resolve({ dataUri: 'private-old-pixels', width: 80, height: 60, strokes: [] }));
  expect(test.save).not.toHaveBeenCalled(); expect(test.stop).not.toHaveBeenCalled(); expect(ownsVisualDraft('a', a.target)).toBe(false);
});
it('native takeover releases only the captured draft and preserves the existing voice surface', async () => {
  const a = target('chat-a'); await request(a); const id = captureId();
  await act(async () => test.events.get('o8:visual-capture-superseded')?.({ payload: { id } }));
  expect(ownsVisualDraft('a', a.target)).toBe(false); expect(test.cancel).toHaveBeenCalledTimes(1);
  expect(test.save).not.toHaveBeenCalled(); expect(node.textContent).toContain('Another dictation took over');
});
it('can finish a marked frame while microphone permission is still pending', async () => {
  const microphone = deferred<void>(); test.start.mockReturnValueOnce(microphone.promise);
  const a = target('chat-a'); await request(a); const id = captureId();
  await action(id, 'finish');
  expect(test.invoke).toHaveBeenCalledWith('o8_visual_capture_finish', { id });
  expect(test.stop).not.toHaveBeenCalled();
  expect(test.save).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ utterance: '', frames: [expect.objectContaining({ id })] }) }));
  expect(ownsVisualDraft('a', a.target)).toBe(false);
  await act(async () => microphone.resolve());
  expect(test.save).toHaveBeenCalledTimes(1);
});
