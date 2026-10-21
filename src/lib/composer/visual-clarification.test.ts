import { beforeEach, expect, it, vi } from 'vitest';
import type { VisualInstructionDraft } from './visual-draft-store';
import { sampleObservation } from './visual-inspection.test-fixture';
const store = vi.hoisted(() => ({ draft: null as VisualInstructionDraft | null, save: vi.fn() }));
vi.mock('./visual-draft-store', () => ({ readVisualDraft: () => store.draft, saveVisualDraft: async (draft: VisualInstructionDraft) => { store.save(draft); store.draft = draft; } }));
const { openVisualQuestion, answerVisualQuestion } = await import('./visual-clarification');
const routing = { backend: 'codex' as const, model: 'selected', effort: 'low' as const, permissionMode: 'plan' as const, mode: 'single' as const, pickedMode: 'solo' as const, collide: false };
const scope = { principal: 'fixture', target: { threadId: 'thoughts-fixture', repoPath: '/fixture' }, routing };
beforeEach(() => {
  store.save.mockClear(); const observation = sampleObservation();
  store.draft = { principal: scope.principal, status: 'draft', template: { text: '', wireMessage: '', images: [], routing },
    request: { version: 1, id: crypto.randomUUID(), createdAt: new Date().toISOString(), target: scope.target, utterance: 'Remove this button.',
      frames: [{ id: 'frame-a', atMs: 0, width: 320, height: 280, transcript: '', image: observation.image, strokes: [], pins: [], observation,
        candidates: [{ id: 'element-a', name: 'Delete', role: 'button', rect: [0.1, 0.2, 0.1, 0.1] }, { id: 'element-b', name: 'Delete', role: 'button', rect: [0.7, 0.2, 0.1, 0.1] }] }] } };
});
it('shares one optional spatial question and treats an answer or repeated answer only as a draft edit', async () => {
  const question = openVisualQuestion(store.draft!);
  expect(question?.options.map(option => option.label)).toEqual(['Left: Delete', 'Right: Delete']);
  expect(openVisualQuestion(store.draft!)?.id).toBe(question?.id);
  expect(await answerVisualQuestion(scope, 'the left one')).toContain('has not been sent');
  expect(store.draft?.request.clarification).toEqual({ id: question?.id, path: 'intent.target', value: 'element-a', question: question?.question });
  expect(store.draft?.status).toBe('draft'); expect(store.save).toHaveBeenCalledTimes(2);
  expect(await answerVisualQuestion(scope, 'first')).toContain('already confirmed'); expect(store.save).toHaveBeenCalledTimes(2);
});
it('does not turn an answer to obsolete pixels into a new task or a patch on the new mark', async () => {
  openVisualQuestion(store.draft!);
  store.draft!.request.frames[0].observation = { ...sampleObservation(), id: 'new-mark', revision: 2 };
  expect(await answerVisualQuestion(scope, 'first')).toContain('changed'); expect(store.save).toHaveBeenCalledTimes(2);
  expect(store.draft?.request.clarification).toBeUndefined();
});

it('restores the same pending question and accepts its answer after in-memory controller state is lost', async () => {
  const question = openVisualQuestion(store.draft!);
  store.draft = JSON.parse(JSON.stringify(store.draft));
  vi.resetModules();
  const restored = await import('./visual-clarification');
  expect(restored.currentVisualQuestion(store.draft!)?.id).toBe(question?.id);
  expect(await restored.answerVisualQuestion(scope, 'second')).toContain('has not been sent');
  expect(store.draft?.request.clarification?.id).toBe(question?.id);
  expect(store.draft?.request.clarification?.value).toBe('element-b');
});
