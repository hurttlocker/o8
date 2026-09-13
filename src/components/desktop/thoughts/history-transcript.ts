import type { MobilePendingTurnWorkers, MobileTranscriptEntry } from '@/lib/mobile/types';
import type { ExportThreadMessage } from '@/lib/llm/export-thread';
import { consumePendingTurnWorkers } from '@/lib/mobile/turn-receipt';
import {
  deserializeStoredTranscript,
  type StoredTranscriptMessage,
} from '@/lib/transcripts/history-serde';

export type ThoughtsHistoryMessage = ExportThreadMessage & StoredTranscriptMessage & {
  id: string;
  role: MobileTranscriptEntry['role'];
};

export function mapHistoryMessagesToTranscript(
  messages: ThoughtsHistoryMessage[],
  pendingTurnWorkers?: MobilePendingTurnWorkers,
): MobileTranscriptEntry[] {
  return consumePendingTurnWorkers(
    pendingTurnWorkers,
    deserializeStoredTranscript(messages),
  ).messages;
}
