import { visualInstructionScope, type VisualInstructionTarget } from './visual-instruction';

let capture: { id: string; principal: string; scope: string; requestId: string } | null = null;
const listeners = new Set<() => void>();
export function subscribeVisualCapture(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function ownsVisualDraft(principal: string, target: VisualInstructionTarget): boolean {
  return capture?.principal === principal && capture.scope === visualInstructionScope(target);
}
export function claimVisualCapture(id: string, principal: string, target: VisualInstructionTarget, requestId: string) {
  if (capture) throw new Error('Another visual capture is active.');
  capture = { id, principal, scope: visualInstructionScope(target), requestId };
  listeners.forEach(listener => listener());
}
export function releaseVisualCapture(id: string) {
  if (capture?.id !== id) return;
  capture = null; listeners.forEach(listener => listener());
}
