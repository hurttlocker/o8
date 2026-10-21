import { afterEach, expect, it, vi } from 'vitest';
import { inspectVisualDraft, readVisualInspection, invalidateVisualInspection } from './visual-inspection-client';
import { inspectionKey, type VisualInspectionInput } from './visual-inspection';
import { sampleObservation } from './visual-inspection.test-fixture';
const input = (): VisualInspectionInput => ({ principal: 'fixture', requestId: crypto.randomUUID(), observation: sampleObservation(), utterance: 'Make this button smaller.', candidates: [] });
const target = { threadId: 'thoughts-fixture', repoPath: '/fixture' };
afterEach(() => vi.useRealTimers());
it('discards late judgments when a new mark supersedes the original pixels', async () => {
  vi.useFakeTimers();
  const original = input(); let resolve!: (value: Response) => void;
  const transport = vi.fn<typeof fetch>(() => new Promise(done => { resolve = done; }));
  inspectVisualDraft(original, target, transport); await vi.advanceTimersByTimeAsync(180);
  const changed = { ...original, observation: { ...original.observation, id: 'different-mark', revision: 2 } };
  inspectVisualDraft(changed, target, vi.fn(async () => Response.json({ key: inspectionKey(changed), status: 'unavailable' })));
  resolve(Response.json({ key: inspectionKey(original), status: 'observed', target: 'marked-region' }));
  await vi.advanceTimersByTimeAsync(180);
  expect(readVisualInspection(original)).toBeNull();
  expect(readVisualInspection(changed)?.status).toBe('unavailable');
  expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(true);
  invalidateVisualInspection(changed.principal, changed.requestId);
});
it('spends snapshot and typing time from the same deadline instead of granting another network budget', async () => {
  vi.useFakeTimers(); const value = input(); const transport = vi.fn<typeof fetch>();
  inspectVisualDraft(value, target, transport, Date.now() - 900);
  await vi.advanceTimersByTimeAsync(250);
  expect(transport).not.toHaveBeenCalled(); expect(readVisualInspection(value)).toBeNull();
  invalidateVisualInspection(value.principal, value.requestId);
});
it('coalesces the current revision and cancels inspection on submission without changing its original words', async () => {
  vi.useFakeTimers(); const value = input(); const transport = vi.fn<typeof fetch>();
  inspectVisualDraft(value, target, transport); inspectVisualDraft(value, target, transport);
  invalidateVisualInspection(value.principal, value.requestId); await vi.advanceTimersByTimeAsync(200);
  expect(transport).not.toHaveBeenCalled(); expect(value.utterance).toBe('Make this button smaller.');
});
