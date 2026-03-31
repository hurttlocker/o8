export type CompactionTrigger = 'auto' | 'manual' | 'inferred';

export interface CompactionEvent {
  id: string;
  timestamp: Date;
  tokensBefore?: number;
  tokensAfter?: number;
  trigger: CompactionTrigger;
  summary?: string;
  source: 'explicit' | 'summary' | 'inferred';
  boundaryEntryId?: string;
  summaryEntryId?: string;
}

type JsonlUsage = Record<string, unknown>;

type JsonlContentBlock = {
  type?: string;
  text?: string;
  content?: unknown;
};

type JsonlCompactMetadata = {
  trigger?: unknown;
  preTokens?: unknown;
  postTokens?: unknown;
  tokensAfter?: unknown;
};

export interface JsonlEntry {
  type?: string;
  subtype?: string;
  status?: string;
  uuid?: string;
  timestamp?: string;
  content?: string;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  compactMetadata?: JsonlCompactMetadata;
  usage?: JsonlUsage;
  message?: {
    role?: string;
    content?: unknown;
    usage?: JsonlUsage;
  };
}

export const CLAUDE_CODE_CONTEXT_WINDOW_TOKENS = 180_000;
export const CLAUDE_CODE_AUTO_COMPACT_HEADROOM_TOKENS = 13_000;
export const CLAUDE_CODE_AUTO_COMPACT_THRESHOLD_TOKENS =
  CLAUDE_CODE_CONTEXT_WINDOW_TOKENS - CLAUDE_CODE_AUTO_COMPACT_HEADROOM_TOKENS;

const MIN_INFERRED_TOKEN_DROP = 30_000;
const MAX_INFERRED_POST_COMPACT_TOKENS = 130_000;

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseTimestamp(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function normalizeTrigger(value: unknown): CompactionTrigger {
  return value === 'manual' ? 'manual' : value === 'auto' ? 'auto' : 'inferred';
}

function extractTextFromUnknown(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const typedBlock = block as JsonlContentBlock;

    if (typedBlock.type === 'text' && typeof typedBlock.text === 'string') {
      parts.push(typedBlock.text);
      continue;
    }

    if (typedBlock.type === 'tool_result') {
      parts.push(extractTextFromUnknown(typedBlock.content));
    }
  }

  return parts.join('\n').trim();
}

function extractSummaryText(entry: JsonlEntry): string | undefined {
  const summary = extractTextFromUnknown(entry.message?.content);
  return summary || undefined;
}

function usageTotal(usage: JsonlUsage | undefined): number | undefined {
  if (!usage) return undefined;

  const inputTokens = asNumber(usage.input_tokens) ?? 0;
  const cachedInputTokens = asNumber(usage.cached_input_tokens) ?? 0;
  const cacheCreationTokens = asNumber(usage.cache_creation_input_tokens) ?? 0;
  const cacheReadTokens = asNumber(usage.cache_read_input_tokens) ?? 0;

  const total = inputTokens + cachedInputTokens + cacheCreationTokens + cacheReadTokens;
  return total > 0 ? total : undefined;
}

function extractEntryTokenTotal(entry: JsonlEntry): number | undefined {
  return usageTotal(entry.message?.usage) ?? usageTotal(entry.usage);
}

function isCompactBoundary(entry: JsonlEntry): boolean {
  return (
    (entry.type === 'system' && entry.subtype === 'compact_boundary')
    || entry.type === 'compact_boundary'
    || (entry.type === 'system' && entry.subtype === 'status' && typeof entry.content === 'string' && /compact/i.test(entry.content))
    || entry.status === 'compacting'
  );
}

function hasCompactionMarkerBetween(
  entries: JsonlEntry[],
  indices: Set<number>,
  startIndex: number,
  endIndex: number,
): boolean {
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    if (indices.has(index) || entries[index]?.isCompactSummary) return true;
  }
  return false;
}

export function detectCompactionEvents(entries: JsonlEntry[]): CompactionEvent[] {
  const events: CompactionEvent[] = [];
  const explicitBoundaryIndices = new Set<number>();
  const summaryEntryIds = new Set<string>();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isCompactBoundary(entry)) continue;

    explicitBoundaryIndices.add(index);

    const nextEntry = entries[index + 1];
    const summary = nextEntry?.isCompactSummary ? extractSummaryText(nextEntry) : undefined;
    const nextUsageTokens = entries
      .slice(index + 1)
      .map((candidate) => extractEntryTokenTotal(candidate))
      .find((candidate) => typeof candidate === 'number');

    if (nextEntry?.isCompactSummary && nextEntry.uuid) {
      summaryEntryIds.add(nextEntry.uuid);
    }

    const compactMetadata = entry.compactMetadata;
    const tokensBefore = asNumber(compactMetadata?.preTokens);
    const tokensAfter =
      asNumber(compactMetadata?.postTokens)
      ?? asNumber(compactMetadata?.tokensAfter)
      ?? nextUsageTokens;

    events.push({
      id: entry.uuid ?? `compact-boundary-${index}`,
      timestamp: parseTimestamp(entry.timestamp) ?? new Date(0),
      tokensBefore,
      tokensAfter,
      trigger: normalizeTrigger(compactMetadata?.trigger),
      summary,
      source: 'explicit',
      boundaryEntryId: entry.uuid,
      summaryEntryId: nextEntry?.isCompactSummary ? nextEntry.uuid : undefined,
    });
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry.isCompactSummary) continue;
    if (entry.uuid && summaryEntryIds.has(entry.uuid)) continue;

    events.push({
      id: entry.uuid ? `${entry.uuid}-summary` : `compact-summary-${index}`,
      timestamp: parseTimestamp(entry.timestamp) ?? new Date(0),
      trigger: 'inferred',
      summary: extractSummaryText(entry),
      source: 'summary',
      summaryEntryId: entry.uuid,
    });

    if (entry.uuid) {
      summaryEntryIds.add(entry.uuid);
    }
  }

  let previousUsage:
    | {
        index: number;
        tokens: number;
      }
    | undefined;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const tokens = extractEntryTokenTotal(entry);
    const timestamp = parseTimestamp(entry.timestamp);
    const id = entry.uuid ?? `usage-${index}`;
    if (tokens == null || !timestamp) continue;

    if (
      previousUsage
      && previousUsage.tokens >= CLAUDE_CODE_AUTO_COMPACT_THRESHOLD_TOKENS
      && previousUsage.tokens - tokens >= MIN_INFERRED_TOKEN_DROP
      && tokens <= MAX_INFERRED_POST_COMPACT_TOKENS
      && !hasCompactionMarkerBetween(entries, explicitBoundaryIndices, previousUsage.index, index)
    ) {
      events.push({
        id: `${id}-inferred-compaction`,
        timestamp,
        tokensBefore: previousUsage.tokens,
        tokensAfter: tokens,
        trigger: 'inferred',
        source: 'inferred',
      });
    }

    previousUsage = {
      index,
      tokens,
    };
  }

  events.sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());

  const seenIds = new Set<string>();
  return events.filter((event) => {
    if (seenIds.has(event.id)) return false;
    seenIds.add(event.id);
    return true;
  });
}
