export type LiveUpdate = (text: string, spoken?: boolean) => Promise<void>;
/** Only the currently attached talker receives new task updates. No old Live IDs cross sessions. */
export class LiveConversationBridge {
  private listener: LiveUpdate | undefined;
  private attached = false;
  subscribe = (listener: LiveUpdate) => {
    this.listener = listener; this.attached = true;
    return () => { if (this.listener === listener) this.listener = undefined; };
  };
  publish = (text: string, spoken = true, fallback?: LiveUpdate): Promise<void> => {
    return this.listener?.(text, spoken) ?? (!this.attached && fallback ? (spoken ? fallback(text) : fallback(text, false)) : Promise.resolve());
  };
}
export type VoiceFollowupIntent = { kind: 'queue'; text: string } | { kind: 'cancel' } | { kind: 'ordinary' } | { kind: 'clarify' };
export function voiceFollowupIntent(text: string): VoiceFollowupIntent {
  if (/^\s*cancel (?:the )?queued(?: follow[- ]?up)?[.!]?\s*$/i.test(text)) return { kind: 'cancel' };
  const match = text.match(/^\s*(?:queue(?: a follow[- ]?up)?|after (?:this|the current) task)[:,]?\s+(.+?)\s*$/i);
  if (match && /\b(?:do not|don't|don’t|not queue|cancel|never mind|nevermind|not a request|example|quoted|if|unless)\b/i.test(match[1])) return { kind: 'clarify' };
  return match ? { kind: 'queue', text: match[1] } : { kind: 'ordinary' };
}
/** A deliberate single follow-up, tied to one authoritative task terminal. Never an immediate steer. */
export class LiveFollowupQueue {
  private item: { id: string; text: string; afterTaskId: string } | undefined;
  enqueue(id: string, text: string, afterTaskId: string): boolean {
    if (this.item) return this.item.id === id && this.item.text === text && this.item.afterTaskId === afterTaskId;
    this.item = { id, text, afterTaskId }; return true;
  }
  cancel(): boolean { const existed = Boolean(this.item); this.item = undefined; return existed; }
  take(taskId: string, confirmedTerminal: boolean) {
    if (!confirmedTerminal || this.item?.afterTaskId !== taskId) return null;
    const item = this.item; this.item = undefined; return item;
  }
  get pending() { return this.item; }
}
