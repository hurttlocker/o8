/**
 * Non-destructive merge of an inbound chat transcript onto the stored one.
 *
 * Fixes the transcript-loss bug (#1282): the chat-history POST used to write the
 * inbound `messages` array straight to disk, so a PARTIAL POST — e.g. a mobile
 * client that missed one streamed `output` event and sent a `[user]`-only
 * transcript — would REPLACE the desktop's complete `[user, assistant]` record
 * and the reply vanished everywhere.
 *
 * Contract:
 * - Inbound messages WIN for matching ids (update-by-id).
 * - Stored messages whose id is NOT present in the inbound array are PRESERVED,
 *   so no client can ever drop a turn it simply never saw. An empty/partial
 *   inbound can no longer wipe the file.
 * - Result is ordered chronologically by numeric `timestamp` (handles the
 *   interleaved case where a preserved reply belongs *between* two inbound
 *   messages). Missing/invalid timestamps carry the prior message's value so
 *   they stay put; ties keep concat order (inbound before preserved).
 *
 * Intentional truncation (edit-and-resend / delete-message in the single-writer
 * Assistant tab) must NOT go through here — those callers pass `replace: true`
 * to the route for a full replace, because a shorter array can't be told apart
 * from a partial-loss array by inspection.
 */
export interface ChatMessageLike {
  id?: unknown;
  timestamp?: unknown;
  [key: string]: unknown;
}

function timestampOf(message: ChatMessageLike): number | null {
  const value = message?.timestamp;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function mergeChatMessages<T extends ChatMessageLike>(existing: T[], inbound: T[]): T[] {
  const inboundList = Array.isArray(inbound) ? inbound : [];
  const existingList = Array.isArray(existing) ? existing : [];

  const inboundIds = new Set<string>();
  for (const message of inboundList) {
    if (message && typeof message.id === 'string') inboundIds.add(message.id);
  }

  // On-disk messages the inbound payload doesn't carry — the turns a partial
  // POST would otherwise drop. Messages without an id can't be matched, so we
  // keep them too (defensive; desktop + mobile always stamp ids).
  const preserved = existingList.filter(
    (message) => !(message && typeof message.id === 'string' && inboundIds.has(message.id)),
  );

  // Fast path: inbound already covers everything on disk (the normal
  // full-transcript POST) — return it untouched, no reordering.
  if (preserved.length === 0) return inboundList;

  const concat: T[] = [...inboundList, ...preserved];
  const decorated = concat.map((message, index) => ({ message, index, ts: timestampOf(message) }));
  // Carry a missing/invalid timestamp forward from the prior message so an
  // unstamped row sorts next to where it actually sat.
  let carry = 0;
  for (const entry of decorated) {
    if (entry.ts === null) entry.ts = carry;
    else carry = entry.ts;
  }
  decorated.sort((a, b) => (a.ts! - b.ts!) || (a.index - b.index));
  return decorated.map((entry) => entry.message);
}
