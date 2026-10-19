import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';
import type { VisualInstructionTarget } from './visual-instruction';

export interface VisualCaptureTarget {
  principal: string; target: VisualInstructionTarget; label: string;
  eligible: () => boolean;
  template: () => ComposerQueuePayload;
}
export class VisualCaptureTargets {
  private targets = new Set<VisualCaptureTarget>();
  private focused: VisualCaptureTarget | null = null;
  private listener: ((target: VisualCaptureTarget) => void) | null = null;
  register(target: VisualCaptureTarget) { this.targets.add(target); return () => { this.targets.delete(target); if (this.focused === target) this.focused = null; }; }
  focus(target: VisualCaptureTarget) { if (this.targets.has(target)) this.focused = target; }
  subscribe(listener: (target: VisualCaptureTarget) => void) { this.listener = listener; return () => { if (this.listener === listener) this.listener = null; }; }
  request(target?: VisualCaptureTarget): boolean {
    const available = [...this.targets].filter(item => item.eligible());
    const selected = target ?? (this.focused && available.includes(this.focused) ? this.focused : available.length === 1 ? available[0] : null);
    if (!selected || !available.includes(selected) || !this.listener) return false;
    this.focused = selected; this.listener(selected); return true;
  }
}
export const visualCaptureTargets = new VisualCaptureTargets();
