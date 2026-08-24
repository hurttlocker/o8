import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { dedupeDisplayMessages } from './dedupe-display-messages';

/**
 * Compose the orchestrator transcript that actually renders.
 *
 * Three sources feed it:
 *  - `historyEntries` — older pages pulled in by scroll-up backfill (oldest);
 *  - `chatMessages`   — the thread's persisted history, already merged with any
 *                       live transcript by the thread-load path;
 *  - `streamMessages` — the live orchestrator stream for the current turn.
 *
 * This used to pick `streamMessages` OR `chatMessages`, never both. The stream
 * starts empty and fills on the first live event, so a restored thread rendered
 * correctly until ANY event arrived — then the whole persisted history was
 * dropped in favour of that one entry. A thread holding 25 stored messages
 * showed a single dispatch card in whitespace, which reads as a lost session
 * exactly when the history matters most (#1839).
 *
 * They are concatenated oldest-to-newest instead, and {@link dedupeDisplayMessages}
 * collapses the overlap — which is what its own contract describes: the
 * transcript is *composed from* loaded history and the live stream, and the
 * same logical message may appear in both with the same id or across the
 * optimistic/echo boundary with differing ids.
 */
export function resolveDisplayMessages(sources: {
  historyEntries: MobileTranscriptEntry[];
  chatMessages: MobileTranscriptEntry[];
  streamMessages: MobileTranscriptEntry[];
}): MobileTranscriptEntry[] {
  const { historyEntries, chatMessages, streamMessages } = sources;
  const base = streamMessages.length > 0
    ? [...chatMessages, ...streamMessages]
    : chatMessages;
  return dedupeDisplayMessages(
    historyEntries.length > 0 ? [...historyEntries, ...base] : base,
  );
}
