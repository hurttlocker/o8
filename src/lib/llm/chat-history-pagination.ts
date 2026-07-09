import { createHash } from 'node:crypto';

const DEFAULT_PAGE_LIMIT = 50;
const MIN_PAGE_LIMIT = 1;
const MAX_PAGE_LIMIT = 200;
const CURSOR_VERSION = 1;

type ChatHistoryMessage = Record<string, unknown>;

export interface ChatHistoryPageRequest {
  limit: number;
  before: string | null;
}

export interface ChatHistoryPageMetadata {
  revision: string;
  total: number;
  hasMore: boolean;
  beforeCursor: string | null;
}

export type ChatHistoryPageResult =
  | {
      ok: true;
      messages: ChatHistoryMessage[];
      page: ChatHistoryPageMetadata;
    }
  | {
      ok: false;
      error: 'cursor_invalid';
      currentRevision: string;
    };

interface ChatHistoryCursor {
  v: typeof CURSOR_VERSION;
  revision: string;
  anchorId: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (child !== undefined && typeof child !== 'function' && typeof child !== 'symbol') {
        sorted[key] = canonicalize(child);
      }
    }
    return sorted;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function hasStableId(message: ChatHistoryMessage): message is ChatHistoryMessage & { id: string } {
  return typeof message.id === 'string' && message.id.trim().length > 0;
}

function legacyMessageFingerprint(message: ChatHistoryMessage): string {
  const withoutId = { ...message };
  delete withoutId.id;
  return createHash('sha256').update(canonicalJson(withoutId)).digest('hex').slice(0, 24);
}

/**
 * Preserve client-authored ids and deterministically backfill legacy rows.
 *
 * The occurrence suffix keeps byte-identical legacy rows addressable without
 * relying on their absolute array index, so appending newer turns cannot move
 * an existing cursor anchor.
 */
export function ensureStableChatMessageIds(messages: readonly unknown[]): ChatHistoryMessage[] {
  const records = messages.filter(
    (message): message is ChatHistoryMessage => Boolean(message && typeof message === 'object' && !Array.isArray(message)),
  );
  const reserved = new Set(
    records.filter(hasStableId).map((message) => message.id),
  );
  const occurrences = new Map<string, number>();

  return records.map((message) => {
    if (hasStableId(message)) return message;

    const fingerprint = legacyMessageFingerprint(message);
    const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
    occurrences.set(fingerprint, occurrence);
    const base = `legacy-${fingerprint}${occurrence > 1 ? `-${occurrence}` : ''}`;
    let id = base;
    let collision = 1;
    while (reserved.has(id)) {
      id = `${base}-${collision}`;
      collision += 1;
    }
    reserved.add(id);
    return { ...message, id };
  });
}

/** A semantic record revision: stable across savedAt-only rewrites. */
export function chatHistoryRevision(record: Record<string, unknown>): string {
  const semanticRecord = { ...record };
  delete semanticRecord.savedAt;
  delete semanticRecord.page;
  const messages = Array.isArray(semanticRecord.messages)
    ? ensureStableChatMessageIds(semanticRecord.messages)
    : [];
  semanticRecord.messages = messages;
  return createHash('sha256').update(canonicalJson(semanticRecord)).digest('hex');
}

export function parseChatHistoryPageRequest(
  limitParam: string | null,
  beforeParam: string | null,
): ChatHistoryPageRequest | null {
  if (limitParam === null && beforeParam === null) return null;
  const parsed = limitParam === null ? DEFAULT_PAGE_LIMIT : Number(limitParam);
  const finite = Number.isFinite(parsed) ? Math.trunc(parsed) : DEFAULT_PAGE_LIMIT;
  return {
    limit: Math.min(MAX_PAGE_LIMIT, Math.max(MIN_PAGE_LIMIT, finite)),
    before: beforeParam,
  };
}

function encodeCursor(cursor: ChatHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): ChatHistoryCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<ChatHistoryCursor>;
    if (
      parsed.v !== CURSOR_VERSION
      || typeof parsed.revision !== 'string'
      || !parsed.revision
      || typeof parsed.anchorId !== 'string'
      || !parsed.anchorId
    ) return null;
    return parsed as ChatHistoryCursor;
  } catch {
    return null;
  }
}

export function pageChatHistoryMessages(
  messages: readonly unknown[],
  request: ChatHistoryPageRequest,
  revision: string,
): ChatHistoryPageResult {
  const stableMessages = ensureStableChatMessageIds(messages);
  const total = stableMessages.length;
  let end = total;

  if (request.before !== null) {
    const cursor = decodeCursor(request.before);
    if (!cursor || cursor.revision !== revision) {
      return { ok: false, error: 'cursor_invalid', currentRevision: revision };
    }
    const anchorIndexes = stableMessages.reduce<number[]>((indexes, message, index) => {
      if (message.id === cursor.anchorId) indexes.push(index);
      return indexes;
    }, []);
    if (anchorIndexes.length !== 1) {
      return { ok: false, error: 'cursor_invalid', currentRevision: revision };
    }
    end = anchorIndexes[0];
  }

  const start = Math.max(0, end - request.limit);
  const pageMessages = stableMessages.slice(start, end);
  const hasMore = start > 0;
  const beforeCursor = hasMore && pageMessages.length > 0
    ? encodeCursor({
        v: CURSOR_VERSION,
        revision,
        anchorId: pageMessages[0].id as string,
      })
    : null;

  return {
    ok: true,
    messages: pageMessages,
    page: { revision, total, hasMore, beforeCursor },
  };
}
