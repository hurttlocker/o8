import type { MobileTranscriptEntry } from '@/lib/mobile/types';

export type StoredTranscriptMessage = {
  id?: string;
  role?: MobileTranscriptEntry['role'];
  content?: string;
  text?: string;
  persistedVersion?: number;
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
  statusEvent?: MobileTranscriptEntry['statusEvent'];
  isPartial?: boolean;
  isCompaction?: boolean;
};

export interface SerializeTranscriptForStorageOptions {
  timestampFallback?: 'now' | 'zero';
}

export interface DeserializeStoredTranscriptOptions {
  dropInvalid?: boolean;
}

function isStoredTranscriptMessage(value: unknown): value is StoredTranscriptMessage {
  return Boolean(value && typeof value === 'object');
}

function isTranscriptRole(value: unknown): value is MobileTranscriptEntry['role'] {
  return value === 'user' || value === 'assistant' || value === 'system' || value === 'tool';
}

function timestampLabelFrom(timestamp: unknown): string {
  return typeof timestamp === 'number' && timestamp
    ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
}

function fallbackTimestampFor(message: StoredTranscriptMessage): number {
  return message.statusEvent?.kind === 'mission-complete' ? 0 : Date.now();
}

function deserializeMessage(value: unknown, dropInvalid: boolean): MobileTranscriptEntry | null {
  const message = isStoredTranscriptMessage(value) ? value : null;
  if (!message || message.isPartial) return null;
  if (dropInvalid && (typeof message.id !== 'string' || !isTranscriptRole(message.role))) return null;

  const timestamp = dropInvalid
    ? (typeof message.timestamp === 'number' ? message.timestamp : undefined)
    : (message.timestamp ?? fallbackTimestampFor(message));
  const text = dropInvalid
    ? (typeof message.text === 'string'
        ? message.text
        : typeof message.content === 'string'
          ? message.content
          : '')
    : (message.text ?? message.content ?? '');

  return {
    id: message.id as string,
    role: message.role as MobileTranscriptEntry['role'],
    text,
    persistedVersion: typeof message.persistedVersion === 'number'
      ? message.persistedVersion
      : undefined,
    type: message.type ?? (message.compaction || message.isCompaction ? 'compaction' : 'message'),
    media: message.media,
    toolCalls: message.toolCalls,
    timestamp,
    timestampLabel: typeof message.timestampLabel === 'string'
      ? message.timestampLabel
      : timestampLabelFrom(message.timestamp),
    model: dropInvalid
      ? (typeof message.model === 'string' ? message.model : undefined)
      : message.model,
    tokens: message.tokens,
    costUsd: dropInvalid
      ? (typeof message.costUsd === 'number' ? message.costUsd : undefined)
      : message.costUsd,
    sources: message.sources,
    thinking: dropInvalid
      ? (typeof message.thinking === 'string' ? message.thinking : undefined)
      : message.thinking,
    thinkingSteps: message.thinkingSteps,
    thinkingDurationMs: dropInvalid
      ? (typeof message.thinkingDurationMs === 'number' ? message.thinkingDurationMs : undefined)
      : message.thinkingDurationMs,
    recalledFacts: dropInvalid
      ? (typeof message.recalledFacts === 'number' ? message.recalledFacts : undefined)
      : message.recalledFacts,
    command: message.command,
    compaction: message.compaction,
    statusEvent: message.statusEvent,
  };
}

export function serializeTranscriptForStorage(
  entries: MobileTranscriptEntry[],
  options?: SerializeTranscriptForStorageOptions,
): StoredTranscriptMessage[] {
  const timestampFallback = options?.timestampFallback ?? 'now';
  return entries.map((entry) => ({
    id: entry.id,
    role: entry.role,
    content: entry.text,
    persistedVersion: entry.persistedVersion,
    type: entry.type,
    media: entry.media,
    toolCalls: entry.toolCalls,
    timestamp: entry.timestamp ?? (timestampFallback === 'zero' ? 0 : Date.now()),
    timestampLabel: entry.timestampLabel,
    model: entry.model,
    tokens: entry.tokens,
    costUsd: entry.costUsd,
    sources: entry.sources,
    thinking: entry.thinking,
    thinkingSteps: entry.thinkingSteps,
    thinkingDurationMs: entry.thinkingDurationMs,
    recalledFacts: entry.recalledFacts,
    command: entry.command,
    compaction: entry.compaction,
    statusEvent: entry.statusEvent,
  }));
}

export function deserializeStoredTranscript(
  stored: readonly unknown[],
  options?: DeserializeStoredTranscriptOptions,
): MobileTranscriptEntry[] {
  const dropInvalid = options?.dropInvalid ?? false;
  return stored
    .map((message) => deserializeMessage(message, dropInvalid))
    .filter((message): message is MobileTranscriptEntry => message !== null);
}
