import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { LiveEvent } from './session';

type Fragment = { id: string; text: string; start: number; end: number; entryId: string; timestamp: number; submitted?: string };
type Group = { direction: 'input' | 'output'; fragments: Fragment[]; revision: number };

/** Display grouping only. Pauses and speaker changes never authorize a CLI turn. */
export class LiveCaptions {
  private seen = new Set<string>();
  private groups: Group[] = [];
  constructor(private sessionId: string, private publish: (entries: MobileTranscriptEntry[]) => void) {}

  observe(event: LiveEvent): void {
    const direction = event.type === 'session.input_transcript.delta' ? 'input'
      : event.type === 'session.output_transcript.delta' ? 'output' : null;
    if (!direction || typeof event.event_id !== 'string' || this.seen.has(event.event_id)
      || typeof event.delta !== 'string' || !event.delta
      || typeof event.start_ms !== 'number' || !Number.isFinite(event.start_ms) || event.start_ms < 0
      || typeof event.end_ms !== 'number' || !Number.isFinite(event.end_ms) || event.end_ms < event.start_ms) return;
    this.seen.add(event.event_id);
    const fragment: Fragment = { id: event.event_id, text: event.delta, start: event.start_ms, end: event.end_ms,
      entryId: `voice-caption-${crypto.randomUUID()}`, timestamp: Date.now() };
    // Full duplex: an acknowledgment must not split the caller's growing bubble.
    let group = this.groups.findLast(candidate => candidate.direction === direction);
    const tail = group?.fragments.at(-1);
    if (!group || tail?.submitted || event.start_ms - tail!.end > 1500) {
      group = { direction, fragments: [], revision: 0 };
      this.groups.push(group);
    }
    group.fragments.push(fragment);
    group.revision++;
    this.publish(this.entries(group));
  }

  /** Link exact recognized fragments only after the normal composer minted its send handle. */
  submitted(fragmentIds: string[], userMessageId: string): void {
    const selected = new Set(fragmentIds);
    for (const group of this.groups) {
      if (group.direction !== 'input') continue;
      let changed = false;
      for (const fragment of group.fragments) {
        if (selected.has(fragment.id) && !fragment.submitted) { fragment.submitted = userMessageId; changed = true; }
      }
      if (changed) { group.revision++; this.publish(this.entries(group)); }
    }
  }

  private entries(group: Group): MobileTranscriptEntry[] {
    const runs: Fragment[][] = [];
    for (const fragment of group.fragments) {
      const last = runs.at(-1);
      if (last && last[0].submitted === fragment.submitted) last.push(fragment);
      else runs.push([fragment]);
    }
    return runs.map(fragments => {
      const first = fragments[0];
      return { id: first.entryId, role: group.direction === 'input' ? 'user' : 'assistant',
        text: fragments.map(fragment => fragment.text).join(''), timestamp: first.timestamp,
        timestampLabel: new Date(first.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        voice: { sessionId: this.sessionId, direction: group.direction, revision: group.revision,
          startMs: first.start, endMs: fragments.at(-1)!.end, delegatedUserMessageId: first.submitted } };
    });
  }
}
