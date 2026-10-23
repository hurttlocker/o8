import type { MobileTranscriptEntry } from '@/lib/mobile/types';

export const isCompactionEntry = (entry: MobileTranscriptEntry) => entry.type === 'compaction' || Boolean(entry.compaction);

function contextUsers(messages: MobileTranscriptEntry[]): MobileTranscriptEntry[] {
  const boundary = messages.findLastIndex(isCompactionEntry);
  if (boundary < 0) return [];
  const keptIds = new Set(messages.flatMap(message => message.compaction?.scorer?.buckets.keep ?? []));
  return messages.filter((message, index) => message.role === 'user' && !message.voice && (index < boundary || keptIds.has(message.id)));
}

const sameUserOccurrence = (left: MobileTranscriptEntry, right: MobileTranscriptEntry) => left.id === right.id
  || typeof left.timestamp === 'number' && left.timestamp === right.timestamp && left.text === right.text;

/** Correlate replay with pre-compaction identities, including explicit keeps. */
export function isCarriedCompactionUser(entry: MobileTranscriptEntry, messages: MobileTranscriptEntry[]): boolean {
  return entry.role === 'user' && !entry.voice && contextUsers(messages).some(original => sameUserOccurrence(entry, original));
}

/** Already persisted aliases can arrive from a stale client during reload. */
export function withoutCompactionReplay(entries: MobileTranscriptEntry[]): MobileTranscriptEntry[] {
  const originals = contextUsers(entries);
  if (!originals.length) return entries;
  const originalIds = new Set(originals.map(entry => entry.id));
  const next = entries.filter(entry => entry.role !== 'user' || entry.voice || originalIds.has(entry.id)
    || !originals.some(original => sameUserOccurrence(entry, original)));
  return next.length === entries.length ? entries : next;
}

/** Session context contains retained turns; only its boundary is a new event. */
export function mergeCompactionMarkers(messages: MobileTranscriptEntry[], context: MobileTranscriptEntry[]): MobileTranscriptEntry[] {
  let next = messages;
  for (const marker of context.filter(isCompactionEntry)) {
    if (next.some(entry => entry.id === marker.id)) continue;
    const timestamp = marker.compaction?.timestamp ?? marker.timestamp;
    const index = typeof timestamp === 'number' ? next.findIndex(entry => typeof entry.timestamp === 'number' && entry.timestamp > timestamp) : -1;
    next = [...next];
    next.splice(index < 0 ? next.length : index, 0, marker);
  }
  return next;
}
