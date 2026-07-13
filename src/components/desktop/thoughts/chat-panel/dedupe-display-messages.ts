import type { MobileTranscriptEntry } from '@/lib/mobile/types';

/**
 * Optimistic/echo user-dedupe window. After a mid-conversation reload (HMR /
 * remount) the RESTORED user bubble (persisted client id, e.g.
 * `orch-user-1783944779973`) and a LIVE-minted optimistic user bubble
 * (`orch-user-<newTs>`) are the same logical message but carry DIFFERENT ids,
 * so id-level dedupe alone can't collapse them. This window is deliberately
 * tight — 15s — so it only ever eats an echo of the SAME send, never a message
 * the operator legitimately re-typed minutes apart.
 */
export const USER_ECHO_DEDUPE_WINDOW_MS = 15_000;

/**
 * Collapse duplicate entries out of the merged transcript before it renders.
 *
 * The orchestrator transcript is composed from two overlapping sources —
 * loaded thread history (restored into `chatMessages` / seeded into the stream)
 * and the live orchestrator stream (`orchStream.messages`). When they overlap
 * after a remount the same logical message can land twice: either with the
 * SAME id (missing id-level dedupe) or with DIFFERING ids across the
 * optimistic/echo boundary (a restored persisted id vs a freshly-minted live
 * id). Both render as two identical bubbles in the same minute.
 *
 * Pass 1 removes exact-id duplicates (last occurrence's data wins — it's the
 * most complete — at the first occurrence's slot). Pass 2 collapses a later
 * `user` entry whose trimmed text matches an earlier `user` entry within
 * {@link USER_ECHO_DEDUPE_WINDOW_MS}, keeping the earlier (durable) one.
 *
 * Returns the SAME array reference when nothing needed collapsing, so the
 * composition memo stays referentially stable on the common path.
 */
export function dedupeDisplayMessages(
  entries: MobileTranscriptEntry[],
): MobileTranscriptEntry[] {
  if (entries.length < 2) return entries;

  // ── Pass 1 — id-level dedupe (last data wins, first position wins).
  const indexById = new Map<string, number>();
  const byId: MobileTranscriptEntry[] = [];
  let idCollision = false;
  for (const entry of entries) {
    const seen = indexById.get(entry.id);
    if (seen == null) {
      indexById.set(entry.id, byId.length);
      byId.push(entry);
    } else {
      idCollision = true;
      byId[seen] = entry;
    }
  }

  // ── Pass 2 — optimistic/echo user dedupe (differing ids, same message).
  const result: MobileTranscriptEntry[] = [];
  const seenUsers: Array<{ text: string; timestamp: number | undefined }> = [];
  let userCollision = false;
  for (const entry of byId) {
    if (entry.role === 'user') {
      const text = entry.text.trim();
      const timestamp = entry.timestamp;
      const isEcho = text.length > 0 && seenUsers.some((prev) => {
        if (prev.text !== text) return false;
        // Both timestamps present → require the tight window. If either is
        // missing (persisted restores always carry one, so this is an edge),
        // fall back to text-identity — that only happens for an echo.
        if (typeof timestamp === 'number' && typeof prev.timestamp === 'number') {
          return Math.abs(timestamp - prev.timestamp) <= USER_ECHO_DEDUPE_WINDOW_MS;
        }
        return true;
      });
      if (isEcho) {
        userCollision = true;
        continue;
      }
      seenUsers.push({ text, timestamp });
    }
    result.push(entry);
  }

  if (!idCollision && !userCollision) return entries;
  return result;
}
