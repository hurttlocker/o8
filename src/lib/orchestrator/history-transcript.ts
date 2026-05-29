import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import {
  deserializeStoredTranscript,
  serializeTranscriptForStorage,
  type SerializeTranscriptForStorageOptions,
} from '@/lib/transcripts/history-serde';

export function serializeThoughtsHistoryMessages(
  messages: MobileTranscriptEntry[],
  options?: SerializeTranscriptForStorageOptions,
) {
  return serializeTranscriptForStorage(messages, options);
}

export function transcriptMatchesStoredHistory(
  current: MobileTranscriptEntry[],
  candidateMessages: unknown,
) {
  if (!Array.isArray(candidateMessages)) {
    return false;
  }

  const normalizedCurrent = deserializeStoredTranscript(
    serializeThoughtsHistoryMessages(current, { timestampFallback: 'zero' }),
    { dropInvalid: true },
  );
  const normalizedCandidate = deserializeStoredTranscript(candidateMessages, { dropInvalid: true });

  return JSON.stringify(serializeThoughtsHistoryMessages(normalizedCurrent, { timestampFallback: 'zero' }))
    === JSON.stringify(serializeThoughtsHistoryMessages(normalizedCandidate, { timestampFallback: 'zero' }));
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

function firstMeaningfulTranscriptLine(
  messages: MobileTranscriptEntry[],
  roles?: MobileTranscriptEntry['role'][],
) {
  for (const message of messages) {
    if (message.type === 'command') continue;
    if (roles && !roles.includes(message.role)) continue;
    const source = message.type === 'compaction'
      ? message.compaction?.summary ?? message.text
      : message.text;
    const line = firstMeaningfulCompactionLine(source);
    if (line) {
      return line;
    }
  }
  return '';
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

export function buildOrchestratorArchiveTitle(input: {
  messages: MobileTranscriptEntry[];
  planText?: string | null;
}) {
  const compactionSeed = firstMeaningfulCompactionLine(extractLatestCompactionSummary(input.messages));
  const userSeed = firstMeaningfulTranscriptLine(input.messages, ['user']);
  const activitySeed = firstMeaningfulTranscriptLine(input.messages);
  const planSeed = firstMeaningfulCompactionLine(input.planText);
  return compactTitle(compactionSeed || userSeed || activitySeed || planSeed || 'Thread archive');
}
