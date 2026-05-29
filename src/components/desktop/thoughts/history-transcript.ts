import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { ExportThreadMessage } from '@/lib/llm/export-thread';
import {
  deserializeStoredTranscript,
  type StoredTranscriptMessage,
} from '@/lib/transcripts/history-serde';

export type ThoughtsHistoryMessage = ExportThreadMessage & StoredTranscriptMessage & {
  id: string;
  role: MobileTranscriptEntry['role'];
};

export function mapHistoryMessagesToTranscript(messages: ThoughtsHistoryMessage[]): MobileTranscriptEntry[] {
  return deserializeStoredTranscript(messages);
}
