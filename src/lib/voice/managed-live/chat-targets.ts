import type { LiveState } from './session';

export interface ManagedChatVoiceTarget {
  standalone?: true;
  eligible: () => boolean;
  state: () => LiveState;
  toggle: () => Promise<void>;
}
const ownsAudio = (state: LiveState) => ['connecting', 'live', 'closing', 'unknown'].includes(state);

/** One voice owner, independent of how many chat panes are mounted. */
export class ManagedChatVoiceTargets {
  private targets = new Set<ManagedChatVoiceTarget>();
  private focused: ManagedChatVoiceTarget | null = null;
  private owner: ManagedChatVoiceTarget | null = null;
  register(target: ManagedChatVoiceTarget): () => void {
    this.targets.add(target);
    return () => { this.targets.delete(target); if (this.focused === target) this.focused = null; };
  }
  focus(target: ManagedChatVoiceTarget): void { if (this.targets.has(target)) this.focused = target; }
  async request(target: ManagedChatVoiceTarget): Promise<boolean> {
    if (this.owner && !ownsAudio(this.owner.state())) this.owner = null;
    if (this.owner && this.owner !== target) return false;
    if (target.state() === 'unknown' || target.state() === 'closing') return false;
    if ((!target.standalone && !this.targets.has(target)) || !target.eligible()) return false;
    this.owner = target;
    await target.toggle();
    if (this.owner === target && !ownsAudio(target.state())) this.owner = null;
    return true;
  }
  async hotkey(foreground: boolean): Promise<boolean> {
    if (this.owner && ownsAudio(this.owner.state())) {
      if (this.owner.standalone || this.owner.state() === 'unknown' || this.owner.state() === 'closing') return false;
      await this.owner.toggle(); // Stop the pinned voice session, even after focus moves.
      return true;
    }
    if (!foreground) return false;
    const visible = [...this.targets].filter(target => target.eligible());
    const target = this.focused && visible.includes(this.focused) ? this.focused : visible.length === 1 ? visible[0] : null;
    return target ? this.request(target) : false;
  }
}

export const managedChatVoiceTargets = new ManagedChatVoiceTargets();
