import { afterEach, expect, it, vi } from 'vitest';
import type { VisualInstructionDraft } from './visual-draft-store';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('keeps a same-request edit that arrives while an earlier discard is being persisted', async () => {
  const stored = new Map<string, unknown>();
  const pending: Array<() => void> = [];
  const database = {
    transaction: () => {
      const transaction = { oncomplete: null as null | (() => void), objectStore: () => ({
        put: (value: unknown, key: string) => pending.push(() => { stored.set(key, value); transaction.oncomplete?.(); }),
        delete: (key: string) => pending.push(() => { stored.delete(key); transaction.oncomplete?.(); }),
      }) };
      return transaction;
    },
  };
  vi.stubGlobal('indexedDB', { open: () => {
    const request = { result: database, onsuccess: null as null | (() => void) };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } });
  const { saveVisualDraft, removeVisualDraft, readVisualDraft } = await import('./visual-draft-store');
  const target = { repoPath: '/project', threadId: 'chat-a' };
  const original = { principal: 'local', status: 'draft', request: { id: 'same-request', target, utterance: 'Original' } } as VisualInstructionDraft;
  const save = saveVisualDraft(original);
  await vi.waitFor(() => expect(pending).toHaveLength(1)); pending.shift()!(); await save;
  const removal = removeVisualDraft('local', target, original.request.id);
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  const edited = { ...original, request: { ...original.request, utterance: 'New words after discard began' } };
  const update = saveVisualDraft(edited);
  pending.shift()!(); await removal;
  expect(readVisualDraft('local', target)?.request.utterance).toBe(edited.request.utterance);
  await vi.waitFor(() => expect(pending).toHaveLength(1)); pending.shift()!(); await update;
  expect([...stored.values()]).toEqual([edited]);
});
