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

function isMissionStatsTitle(value: string) {
  return /^[\p{L}\p{N}._/-]+(?:\s+[\p{L}\p{N}._/-]+){0,2}\s+with\s+\d+\s+tasks?(?:\s*·\s*\d+\s+merges?)?(?:\s*·\s*\d{4}-\d{2}-\d{2})?$/iu.test(value);
}

function titleSeed(value: string | null | undefined) {
  const normalized = normalizeTitleSeed(value ?? '');
  return normalized && !isMissionStatsTitle(normalized) ? normalized : '';
}

function meaningfulTranscriptLine(
  messages: MobileTranscriptEntry[],
  options: { roles?: MobileTranscriptEntry['role'][]; from: 'start' | 'end' },
) {
  const ordered = options.from === 'end' ? [...messages].reverse() : messages;
  for (const message of ordered) {
    if (message.type === 'command') continue;
    if (options.roles && !options.roles.includes(message.role)) continue;
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

function firstMeaningfulTranscriptLine(
  messages: MobileTranscriptEntry[],
  roles?: MobileTranscriptEntry['role'][],
) {
  return meaningfulTranscriptLine(messages, { roles, from: 'start' });
}

function lastMeaningfulTranscriptLine(
  messages: MobileTranscriptEntry[],
  roles?: MobileTranscriptEntry['role'][],
) {
  return meaningfulTranscriptLine(messages, { roles, from: 'end' });
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
  messages?: MobileTranscriptEntry[];
  missionSummary: string;
  compactionSummary?: string | null;
  outcomeTitles?: string[];
}) {
  // Seed order is archive-specificity, strongest first (#1848). A mission archive
  // is cut out of a long-lived orchestrator thread, so any seed drawn from the
  // TOP of the transcript describes the thread, not this mission — every archive
  // from one thread would inherit the same opening line. Packet titles are the
  // only per-mission signal; the compaction summary and the operator's LAST
  // message at least move with the archived slice.
  const outcomeSeed = input.outcomeTitles
    ?.map(titleSeed)
    .find(Boolean) ?? '';
  const compactionSeed = titleSeed(firstMeaningfulCompactionLine(input.compactionSummary));
  const userSeed = titleSeed(lastMeaningfulTranscriptLine(input.messages ?? [], ['user']));
  const missionSeed = titleSeed(input.missionSummary.replace(/^sprint mission for\s+/iu, ''));
  return compactTitle(outcomeSeed || compactionSeed || userSeed || missionSeed || 'Mission complete');
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
