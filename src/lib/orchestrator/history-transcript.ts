import type { MobileTranscriptEntry } from '@/lib/mobile/types';

type StoredTranscriptMessage = {
  id?: string;
  role?: MobileTranscriptEntry['role'];
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

function normalizeStoredMessage(value: unknown): MobileTranscriptEntry | null {
  const message = (value && typeof value === 'object' ? value : null) as StoredTranscriptMessage | null;
  const role = message?.role;
  if (
    !message
    || typeof message.id !== 'string'
    || (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool')
    || message.isPartial
  ) {
    return null;
  }

  return {
    id: message.id,
    role,
    text: typeof message.text === 'string' ? message.text : typeof message.content === 'string' ? message.content : '',
    type: message.type ?? (message.compaction || message.isCompaction ? 'compaction' : 'message'),
    media: message.media,
    toolCalls: message.toolCalls,
    timestamp: typeof message.timestamp === 'number' ? message.timestamp : undefined,
    timestampLabel: typeof message.timestampLabel === 'string' ? message.timestampLabel : undefined,
    model: typeof message.model === 'string' ? message.model : undefined,
    tokens: message.tokens,
    costUsd: typeof message.costUsd === 'number' ? message.costUsd : undefined,
    sources: message.sources,
    thinking: typeof message.thinking === 'string' ? message.thinking : undefined,
    thinkingSteps: message.thinkingSteps,
    thinkingDurationMs: typeof message.thinkingDurationMs === 'number' ? message.thinkingDurationMs : undefined,
    recalledFacts: typeof message.recalledFacts === 'number' ? message.recalledFacts : undefined,
    command: message.command,
    compaction: message.compaction,
  };
}

export function serializeThoughtsHistoryMessages(messages: MobileTranscriptEntry[]) {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.text,
    type: message.type,
    media: message.media,
    toolCalls: message.toolCalls,
    timestamp: message.timestamp ?? Date.now(),
    timestampLabel: message.timestampLabel,
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

export function transcriptMatchesStoredHistory(
  current: MobileTranscriptEntry[],
  candidateMessages: unknown,
) {
  if (!Array.isArray(candidateMessages)) {
    return false;
  }

  const normalizedCandidate = candidateMessages
    .map((message) => normalizeStoredMessage(message))
    .filter((message): message is MobileTranscriptEntry => message !== null);

  return JSON.stringify(serializeThoughtsHistoryMessages(current))
    === JSON.stringify(serializeThoughtsHistoryMessages(normalizedCandidate));
}

function stripCompactionTags(value: string) {
  return value.replace(/<\/?compacted_context\b[^>]*>/gi, '').trim();
}

function normalizeTitleSeed(value: string) {
  return value
    .replace(/^[-*]\s*/u, '')
    .replace(/^current mission state:?\s*/iu, '')
    .replace(/^mission summary:?\s*/iu, '')
    .replace(/\.$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function firstMeaningfulCompactionLine(value: string | null | undefined) {
  if (!value) return '';

  return stripCompactionTags(value)
    .split('\n')
    .map((line) => normalizeTitleSeed(line))
    .find((line) => (
      Boolean(line)
      && !/^decisions made$/iu.test(line)
      && !/^files touched$/iu.test(line)
      && !/^open questions$/iu.test(line)
      && !/^current mission state$/iu.test(line)
      && !/^none$/iu.test(line)
    )) ?? '';
}

function compactTitle(value: string) {
  const normalized = normalizeTitleSeed(value);
  if (!normalized) return 'Mission complete';
  if (normalized.length <= 42) return normalized;
  return normalized.slice(0, 42).replace(/\s+\S*$/u, '').trim() || normalized.slice(0, 42).trim();
}

export function extractLatestCompactionSummary(messages: MobileTranscriptEntry[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const summary = messages[index]?.compaction?.summary;
    if (typeof summary === 'string' && summary.trim()) {
      return stripCompactionTags(summary);
    }
  }
  return null;
}

export function buildMissionArchiveTitle(input: {
  missionSummary: string;
  compactionSummary?: string | null;
  mergedCount: number;
  completedAt: string;
}) {
  const compactionSeed = firstMeaningfulCompactionLine(input.compactionSummary);
  const missionSeed = normalizeTitleSeed(
    input.missionSummary.replace(/^sprint mission for\s+/iu, ''),
  );
  const base = compactTitle(compactionSeed || missionSeed || 'Mission complete');
  const mergedCount = Math.max(0, Math.floor(input.mergedCount));
  const date = new Date(input.completedAt).toISOString().slice(0, 10);
  return `${base} · ${mergedCount} merge${mergedCount === 1 ? '' : 's'} · ${date}`;
}
