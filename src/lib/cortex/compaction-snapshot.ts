import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { getCortexClient } from '@/lib/cortex/client';
import {
  extractJsonlEntryTokenTotal,
  type CompactionEvent,
  type JsonlEntry,
} from '@/lib/runtimes/compaction-detector';

const CLAUDE_PROJECTS_DIR = path.join(homedir(), '.claude', 'projects');
const SNAPSHOT_STORE_DIR = path.join(homedir(), '.cortex-ide');
const SNAPSHOT_STORE_PATH = path.join(SNAPSHOT_STORE_DIR, 'compaction-snapshots.json');
const SNAPSHOT_STORE_TMP_PATH = `${SNAPSHOT_STORE_PATH}.tmp`;
const SNAPSHOT_MARKER = '[compaction-snapshot]';
const MAX_SUMMARY_CHARS = 4_000;
const MAX_TRANSCRIPT_ENTRY_CHARS = 600;
const MAX_TRANSCRIPT_TAIL_ENTRIES = 8;
const MAX_STORED_SNAPSHOTS = 500;

type SnapshotSummarySource =
  | 'compaction-summary'
  | 'assistant-before-boundary'
  | 'transcript-tail'
  | 'unavailable';

type SnapshotTranscriptEntry = {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
};

export interface CompactionSnapshotRecord {
  id: string;
  eventId: string;
  sessionKey: string;
  timestamp: string;
  capturedAt: string;
  trigger: CompactionEvent['trigger'];
  source: CompactionEvent['source'];
  tokensBefore?: number;
  tokensAfter?: number;
  summary: string;
  summarySource: SnapshotSummarySource;
  boundaryEntryId?: string;
  summaryEntryId?: string;
  memoryId?: number;
  sourceLabel: string;
  transcriptTail: SnapshotTranscriptEntry[];
}

interface CompactionSnapshotStoreShape {
  version: 1;
  snapshots: CompactionSnapshotRecord[];
}

const inFlightCaptureIds = new Set<string>();
let snapshotStoreQueue: Promise<void> = Promise.resolve();

function queueSnapshotStoreOperation<T>(operation: () => Promise<T>): Promise<T> {
  const next = snapshotStoreQueue.then(operation, operation);
  snapshotStoreQueue = next.then(() => undefined, () => undefined);
  return next;
}

function normalizeWhitespace(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function truncateText(value: string | undefined, maxChars: number): string {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return '';
  return normalized.length > maxChars
    ? `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
    : normalized;
}

function parseTimestamp(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function snapshotIdFor(sessionKey: string, eventId: string): string {
  return `${sessionKey}::${eventId}`;
}

function sanitizeSourceSegment(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9-_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized.slice(0, 80) || 'snapshot';
}

function buildSourceLabel(sessionKey: string, eventId: string, timestamp: string): string {
  return [
    'compaction-snapshot',
    sanitizeSourceSegment(sessionKey),
    sanitizeSourceSegment(eventId),
    sanitizeSourceSegment(timestamp),
  ].join('-');
}

function extractTextFromUnknown(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const entry = block as {
      type?: string;
      text?: string;
      content?: unknown;
    };

    if (entry.type === 'text' && typeof entry.text === 'string') {
      parts.push(entry.text);
      continue;
    }

    if (entry.type === 'tool_result') {
      const nested = extractTextFromUnknown(entry.content);
      if (nested) parts.push(nested);
    }
  }

  return parts.join('\n').trim();
}

function extractEntryText(entry: JsonlEntry): string {
  const messageText = extractTextFromUnknown(entry.message?.content);
  if (messageText) return messageText;
  return typeof entry.content === 'string' ? entry.content.trim() : '';
}

function findBoundaryIndex(entries: JsonlEntry[], event: CompactionEvent): number {
  if (event.boundaryEntryId) {
    const boundaryIndex = entries.findIndex((entry) => entry.uuid === event.boundaryEntryId);
    if (boundaryIndex >= 0) return boundaryIndex;
  }

  if (event.summaryEntryId) {
    const summaryIndex = entries.findIndex((entry) => entry.uuid === event.summaryEntryId);
    if (summaryIndex >= 0) return Math.max(0, summaryIndex - 1);
  }

  const eventTime = event.timestamp.getTime();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const timestamp = parseTimestamp(entries[index]?.timestamp);
    if (timestamp?.getTime() === eventTime) {
      return index;
    }
  }

  return Math.max(0, entries.length - 1);
}

function collectTranscriptTail(entries: JsonlEntry[], boundaryIndex: number): SnapshotTranscriptEntry[] {
  const transcriptTail: SnapshotTranscriptEntry[] = [];

  for (let index = Math.max(0, boundaryIndex - 1); index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== 'user' && entry?.type !== 'assistant') continue;

    const text = truncateText(extractEntryText(entry), MAX_TRANSCRIPT_ENTRY_CHARS);
    if (!text) continue;

    transcriptTail.push({
      role: entry.type,
      text,
      timestamp: parseTimestamp(entry.timestamp)?.toISOString(),
    });

    if (transcriptTail.length >= MAX_TRANSCRIPT_TAIL_ENTRIES) break;
  }

  return transcriptTail.reverse();
}

function resolveSummary(
  entries: JsonlEntry[],
  boundaryIndex: number,
  event: CompactionEvent,
  transcriptTail: SnapshotTranscriptEntry[],
): { summary: string; summarySource: SnapshotSummarySource } {
  const compactSummary = truncateText(event.summary, MAX_SUMMARY_CHARS);
  if (compactSummary) {
    return {
      summary: compactSummary,
      summarySource: 'compaction-summary',
    };
  }

  for (let index = Math.max(0, boundaryIndex - 1); index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== 'assistant') continue;

    const summary = truncateText(extractEntryText(entry), MAX_SUMMARY_CHARS);
    if (summary) {
      return {
        summary,
        summarySource: 'assistant-before-boundary',
      };
    }
  }

  if (transcriptTail.length > 0) {
    return {
      summary: truncateText(
        transcriptTail.map((entry) => `${entry.role}: ${entry.text}`).join(' '),
        MAX_SUMMARY_CHARS,
      ),
      summarySource: 'transcript-tail',
    };
  }

  return {
    summary: 'No assistant summary was available before compaction.',
    summarySource: 'unavailable',
  };
}

function resolveTokensBefore(entries: JsonlEntry[], boundaryIndex: number, event: CompactionEvent): number | undefined {
  if (typeof event.tokensBefore === 'number') return event.tokensBefore;

  for (let index = Math.max(0, boundaryIndex - 1); index >= 0; index -= 1) {
    const tokens = extractJsonlEntryTokenTotal(entries[index]);
    if (typeof tokens === 'number') return tokens;
  }

  return undefined;
}

function resolveTokensAfter(entries: JsonlEntry[], boundaryIndex: number, event: CompactionEvent): number | undefined {
  if (typeof event.tokensAfter === 'number') return event.tokensAfter;

  for (let index = Math.max(0, boundaryIndex + 1); index < entries.length; index += 1) {
    const tokens = extractJsonlEntryTokenTotal(entries[index]);
    if (typeof tokens === 'number') return tokens;
  }

  return undefined;
}

function formatOptionalValue(label: string, value: string | number | undefined): string {
  return `${label}: ${value ?? 'unknown'}`;
}

function buildSnapshotDocument(snapshot: CompactionSnapshotRecord): string {
  const transcriptTail = snapshot.transcriptTail.length > 0
    ? snapshot.transcriptTail
      .map((entry) => `- ${entry.role} [${entry.timestamp ?? 'unknown'}]: ${entry.text}`)
      .join('\n')
    : '- No transcript entries were available before the compaction boundary.';

  return [
    '# Pre-Compaction Snapshot',
    SNAPSHOT_MARKER,
    '',
    formatOptionalValue('Session Key', snapshot.sessionKey),
    formatOptionalValue('Compaction Event ID', snapshot.eventId),
    formatOptionalValue('Compaction Timestamp', snapshot.timestamp),
    formatOptionalValue('Captured At', snapshot.capturedAt),
    formatOptionalValue('Trigger', snapshot.trigger),
    formatOptionalValue('Source', snapshot.source),
    formatOptionalValue('Tokens Before', snapshot.tokensBefore),
    formatOptionalValue('Tokens After', snapshot.tokensAfter),
    formatOptionalValue('Summary Source', snapshot.summarySource),
    formatOptionalValue('Boundary Entry ID', snapshot.boundaryEntryId),
    formatOptionalValue('Summary Entry ID', snapshot.summaryEntryId),
    '',
    '## Running Summary',
    snapshot.summary,
    '',
    '## Transcript Tail Before Compaction',
    transcriptTail,
  ].join('\n');
}

async function readSnapshotStore(): Promise<CompactionSnapshotStoreShape> {
  try {
    const raw = await readFile(SNAPSHOT_STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CompactionSnapshotStoreShape>;
    return {
      version: 1,
      snapshots: Array.isArray(parsed.snapshots)
        ? parsed.snapshots.filter(Boolean) as CompactionSnapshotRecord[]
        : [],
    };
  } catch {
    return {
      version: 1,
      snapshots: [],
    };
  }
}

async function writeSnapshotStore(store: CompactionSnapshotStoreShape): Promise<void> {
  await mkdir(SNAPSHOT_STORE_DIR, { recursive: true });
  const trimmed: CompactionSnapshotStoreShape = {
    version: 1,
    snapshots: [...store.snapshots]
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, MAX_STORED_SNAPSHOTS),
  };
  await writeFile(SNAPSHOT_STORE_TMP_PATH, `${JSON.stringify(trimmed, null, 2)}\n`, 'utf8');
  await rename(SNAPSHOT_STORE_TMP_PATH, SNAPSHOT_STORE_PATH);
}

async function findStoredSnapshot(snapshotId: string): Promise<CompactionSnapshotRecord | null> {
  return queueSnapshotStoreOperation(async () => {
    const store = await readSnapshotStore();
    return store.snapshots.find((snapshot) => snapshot.id === snapshotId) ?? null;
  });
}

async function persistSnapshotRecord(snapshot: CompactionSnapshotRecord): Promise<void> {
  await queueSnapshotStoreOperation(async () => {
    const store = await readSnapshotStore();
    if (store.snapshots.some((entry) => entry.id === snapshot.id)) {
      return;
    }
    store.snapshots.unshift(snapshot);
    await writeSnapshotStore(store);
  });
}

async function findClaudeSessionEntries(sessionKey: string): Promise<JsonlEntry[]> {
  if (!sessionKey.startsWith('claude-code:')) {
    return [];
  }

  const sessionId = sessionKey.slice('claude-code:'.length);
  if (!sessionId || sessionId.startsWith('live-')) {
    return [];
  }

  const projectDirs = await readdir(CLAUDE_PROJECTS_DIR).catch(() => [] as string[]);

  for (const projectDir of projectDirs) {
    const candidatePath = path.join(CLAUDE_PROJECTS_DIR, projectDir, `${sessionId}.jsonl`);
    try {
      const raw = await readFile(candidatePath, 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as JsonlEntry];
          } catch {
            return [];
          }
        });
    } catch {
      continue;
    }
  }

  return [];
}

async function captureSnapshotWithEntries(
  sessionKey: string,
  event: CompactionEvent,
  entries: JsonlEntry[],
): Promise<void> {
  const captureId = snapshotIdFor(sessionKey, event.id);
  if (inFlightCaptureIds.has(captureId)) {
    return;
  }

  inFlightCaptureIds.add(captureId);

  try {
    const existing = await findStoredSnapshot(captureId);
    if (existing) {
      return;
    }

    const boundaryIndex = findBoundaryIndex(entries, event);
    const transcriptTail = collectTranscriptTail(entries, boundaryIndex);
    const { summary, summarySource } = resolveSummary(entries, boundaryIndex, event, transcriptTail);
    const timestamp = event.timestamp.toISOString();
    const capturedAt = new Date().toISOString();
    const sourceLabel = buildSourceLabel(sessionKey, event.id, timestamp);

    const snapshot: CompactionSnapshotRecord = {
      id: captureId,
      eventId: event.id,
      sessionKey,
      timestamp,
      capturedAt,
      trigger: event.trigger,
      source: event.source,
      tokensBefore: resolveTokensBefore(entries, boundaryIndex, event),
      tokensAfter: resolveTokensAfter(entries, boundaryIndex, event),
      summary,
      summarySource,
      boundaryEntryId: event.boundaryEntryId,
      summaryEntryId: event.summaryEntryId,
      sourceLabel,
      transcriptTail,
    };

    const client = getCortexClient();
    const available = await client.isAvailable().catch(() => false);
    if (!available) {
      console.warn(`[compaction-snapshot] Cortex unavailable; skipping snapshot for ${sessionKey}`);
      return;
    }

    const stored = await client.store(buildSnapshotDocument(snapshot), sourceLabel);
    if (!stored.ok) {
      console.error(`[compaction-snapshot] Failed to persist snapshot for ${sessionKey}`);
      return;
    }

    const persistedSnapshot: CompactionSnapshotRecord = {
      ...snapshot,
      memoryId: stored.memoryId,
    };

    await persistSnapshotRecord(persistedSnapshot);
    console.log(`[compaction-snapshot] Captured ${captureId}${stored.memoryId ? ` memory=${stored.memoryId}` : ''}`);
  } catch (error) {
    console.error(
      `[compaction-snapshot] Failed to capture snapshot for ${sessionKey}`,
      error instanceof Error ? error.message : error,
    );
  } finally {
    inFlightCaptureIds.delete(captureId);
  }
}

export async function capturePreCompactionSnapshot(
  sessionKey: string,
  event: CompactionEvent,
): Promise<void> {
  const entries = await findClaudeSessionEntries(sessionKey);
  if (entries.length === 0) {
    console.warn(`[compaction-snapshot] No transcript entries available for ${sessionKey}`);
    return;
  }

  await captureSnapshotWithEntries(sessionKey, event, entries);
}

export async function capturePreCompactionSnapshotFromEntries(
  sessionKey: string,
  event: CompactionEvent,
  entries: JsonlEntry[],
): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  await captureSnapshotWithEntries(sessionKey, event, entries);
}

export async function listCompactionSnapshots(options: {
  limit?: number;
  sessionKey?: string;
} = {}): Promise<CompactionSnapshotRecord[]> {
  const store = await queueSnapshotStoreOperation(() => readSnapshotStore());
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));

  return store.snapshots
    .filter((snapshot) => options.sessionKey ? snapshot.sessionKey === options.sessionKey : true)
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, limit);
}
