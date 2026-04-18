import type { MobileTranscriptEntry } from '@/lib/mobile/types';

export type ThoughtsHistoryMessage = {
  id: string;
  role: MobileTranscriptEntry['role'];
  content?: string;
  text?: string;
  type?: MobileTranscriptEntry['type'];
  media?: MobileTranscriptEntry['media'];
  toolCalls?: MobileTranscriptEntry['toolCalls'];
  timestamp?: number;
  timestampLabel?: string;
  model?: string;
  tokens?: MobileTranscriptEntry['tokens'];
  costUsd?: number;
  sources?: MobileTranscriptEntry['sources'];
  thinking?: string;
  thinkingSteps?: MobileTranscriptEntry['thinkingSteps'];
  thinkingDurationMs?: MobileTranscriptEntry['thinkingDurationMs'];
  recalledFacts?: MobileTranscriptEntry['recalledFacts'];
  command?: MobileTranscriptEntry['command'];
  compaction?: MobileTranscriptEntry['compaction'];
  isPartial?: boolean;
  isCompaction?: boolean;
};

export function mapHistoryMessagesToTranscript(messages: ThoughtsHistoryMessage[]): MobileTranscriptEntry[] {
  return messages
    .filter((message) => !message.isPartial)
    .map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text ?? message.content ?? '',
      type: message.type ?? (message.compaction || message.isCompaction ? 'compaction' : 'message'),
      media: message.media,
      toolCalls: message.toolCalls,
      timestamp: message.timestamp ?? Date.now(),
      timestampLabel: message.timestampLabel ?? (message.timestamp
        ? new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : ''),
      model: message.model,
      tokens: message.tokens,
      costUsd: message.costUsd,
      sources: message.sources,
      thinking: message.thinking,
      thinkingSteps: message.thinkingSteps,
      thinkingDurationMs: message.thinkingDurationMs,
      recalledFacts: message.recalledFacts,
      command: message.command,
      compaction: message.compaction,
    }));
}
