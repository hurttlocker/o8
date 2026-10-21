import { expect, it, vi } from 'vitest';
import { VisualCaptureTargets, type VisualCaptureTarget } from './visual-capture-targets';
import { claimVisualCapture, ownsVisualDraft, releaseVisualCapture } from './visual-capture-state';
import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';
const target = (threadId: string): VisualCaptureTarget => ({ principal: 'account-a', target: { threadId, repoPath: '/project' }, label: threadId,
  eligible: () => true, template: () => ({} as ComposerQueuePayload) });
it('requires a deliberate destination when two chats are eligible', () => {
  const registry = new VisualCaptureTargets(); const receive = vi.fn(); registry.subscribe(receive);
  const a = target('a'); const b = target('b'); registry.register(a); const unregister = registry.register(b);
  expect(registry.request()).toBe(false); registry.focus(a); expect(registry.request()).toBe(true);
  expect(receive).toHaveBeenLastCalledWith(a); unregister(); expect(registry.request(b)).toBe(false);
});
it('never substitutes another chat for an explicit stale target', () => {
  const registry = new VisualCaptureTargets(); const a = target('a'); const b = target('b'); const receive = vi.fn();
  registry.register(a); registry.register(b); registry.subscribe(receive); a.eligible = () => false;
  expect(registry.request(a)).toBe(false); expect(receive).not.toHaveBeenCalled(); expect(registry.request()).toBe(true);
  expect(receive).toHaveBeenLastCalledWith(b);
});
it('locks only the captured account and chat and ignores stale releases', () => {
  const a = target('a'); claimVisualCapture('capture-a', a.principal, a.target, 'request-a');
  expect(ownsVisualDraft(a.principal, a.target)).toBe(true);
  expect(ownsVisualDraft('account-b', a.target)).toBe(false);
  expect(ownsVisualDraft(a.principal, target('b').target)).toBe(false);
  expect(() => claimVisualCapture('capture-b', a.principal, a.target, 'request-b')).toThrow('active');
  releaseVisualCapture('capture-b'); expect(ownsVisualDraft(a.principal, a.target)).toBe(true);
  releaseVisualCapture('capture-a'); expect(ownsVisualDraft(a.principal, a.target)).toBe(false);
});
