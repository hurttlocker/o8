import { NextRequest, NextResponse } from 'next/server';
import { performance } from 'node:perf_hooks';
import { getOwnedCodexRuntimeTail } from '@/lib/codex/owned';
import { getCodexRuntimeTail } from '@/lib/codex/sessions';
import { loadMobileLlmChatHistory } from '@/lib/llm/mobile-llm-chat';
import type { MobileInboxSnapshot, MobileTranscriptEntry } from '@/lib/mobile/types';
import { mobileInboxSignature } from '@/lib/mobile/inbox-signature';
import { getMobileInboxSnapshot } from '@/lib/mobile/inbox';
import '@/lib/runtimes'; // Ensure runtimes are registered
import { getRuntime } from '@/lib/runtimes/registry';
import { getReviewFileDetail } from '@/lib/review/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Types ──

interface SyncRequest {
  inbox?: { etag?: string };
  history?: { sessionKey: string; sinceId?: string; limit?: number };
  review?: { sessionKey?: string; includeFile?: string };
  linked?: { sessionKey: string; sinceId?: string };
}

interface SyncResponse {
  inbox?: MobileInboxSnapshot | null;
  inboxEtag?: string;
  history?: { sessionKey: string; entries: MobileTranscriptEntry[]; replace?: boolean };
  review?: { file?: unknown };
  linked?: { sessionKey: string; entries: MobileTranscriptEntry[]; replace?: boolean };
  serverTime: string;
  errors?: Record<string, string>;
}

function computeEtag(snapshot: MobileInboxSnapshot): string {
  const sig = mobileInboxSignature(snapshot);
  let hash = 0;
  for (let i = 0; i < sig.length; i++) {
    hash = ((hash << 5) - hash + sig.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

async function resolveInbox(req: SyncRequest['inbox']): Promise<{ snapshot: MobileInboxSnapshot | null; etag: string }> {
  const snapshot = await getMobileInboxSnapshot();
  const etag = computeEtag(snapshot);

  if (req?.etag && req.etag === etag) {
    return { snapshot: null, etag };
  }
  return { snapshot, etag };
}

// ── History resolver ──

function runtimeTailRole(label: string): MobileTranscriptEntry['role'] {
  const normalized = label.toLowerCase();
  if (normalized.includes('assistant')) return 'assistant';
  if (normalized.includes('user')) return 'user';
  if (normalized.includes('tool')) return 'tool';
  return 'system';
}

async function resolveHistory(
  req: NonNullable<SyncRequest['history']>,
): Promise<{ sessionKey: string; entries: MobileTranscriptEntry[]; replace?: boolean }> {
  const { sessionKey, limit: rawLimit } = req;
  const limit = Math.min(Math.max(rawLimit ?? 18, 1), 40);

  if (sessionKey.startsWith('llm-chat:')) {
    const transcript = loadMobileLlmChatHistory(sessionKey, limit).transcript;
    const delta = applyDelta(transcript, req.sinceId);
    return { sessionKey, ...delta };
  }

  if (sessionKey.startsWith('codex-owned:')) {
    const tail = await getOwnedCodexRuntimeTail(sessionKey);
    const entries: MobileTranscriptEntry[] = [];
    for (const group of tail.groups ?? []) {
      const promptText = group.prompt?.trim();
      if (promptText) {
        entries.push({ id: `${group.id}-prompt`, role: 'user', text: promptText, timestampLabel: group.startedAtLabel });
      }
      for (const entry of group.entries) {
        const text = entry.text.trim();
        if (!text) continue;
        if (promptText && text === promptText) continue;
        if (text.startsWith('Usage •') || text.includes('Owned Codex session') || text.includes('Codex run launched')) continue;
        const role = runtimeTailRole(entry.label);
        if (role === 'assistant') {
          entries.push({ id: entry.id, role: 'assistant', text, timestampLabel: entry.timestampLabel });
        } else if (entry.kind === 'tool') {
          entries.push({ id: entry.id, role: 'system', text: `🔧 ${entry.label || 'Tool'}`, timestampLabel: entry.timestampLabel });
        }
      }
    }
    const delta = applyDelta(entries, req.sinceId);
    return { sessionKey, ...delta };
  }

  if (sessionKey.startsWith('codex:')) {
    const tail = await getCodexRuntimeTail(sessionKey);
    const raw: MobileTranscriptEntry[] = [];
    for (const entry of tail.entries ?? []) {
      if (entry.kind === 'event' && entry.label === 'Agent update') {
        raw.push({ id: entry.id, role: 'assistant', text: entry.text, timestampLabel: entry.timestampLabel });
        continue;
      }
      if (entry.kind === 'message') {
        const role = runtimeTailRole(entry.label);
        // Filter system noise
        if (role === 'system' || role === 'user') {
          const lt = entry.text.toLowerCase();
          if (lt.includes('<permissions') || lt.includes('collaboration_mode') || lt.includes('# agents.md') || lt.includes('sandbox_mode')) continue;
        }
        raw.push({ id: entry.id, role, text: entry.text, timestampLabel: entry.timestampLabel });
        continue;
      }
      // Collapse tool calls — skip individual tool entries and tool output.
      // Users see the assistant's summary of what it did, not every raw function call.
      if (entry.kind === 'tool' || entry.kind === 'tool-output') {
        continue;
      }
    }
    // Deduplicate: remove entries with identical text (not just consecutive)
    const seen = new Set<string>();
    const deduped: MobileTranscriptEntry[] = [];
    for (const entry of raw) {
      // Normalize for dedup: trim and take first 200 chars
      const key = `${entry.role}:${entry.text.trim().slice(0, 200)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(entry);
    }
    const delta = applyDelta(deduped, req.sinceId);
    return { sessionKey, ...delta };
  }

  // Claude Code sessions — read from JSONL via runtime adapter
  if (sessionKey.startsWith('claude-code:')) {
    const ccRuntime = getRuntime('claude-code');
    if (ccRuntime?.readTranscript) {
      const entries = await ccRuntime.readTranscript(sessionKey, undefined, limit);
      const transcript: MobileTranscriptEntry[] = entries.map(entry => ({
        id: entry.id,
        role: entry.role === 'user' ? 'user' : entry.role === 'assistant' ? 'assistant' : 'system',
        text: entry.text,
        type: entry.type ?? 'message',
        timestamp: entry.timestamp.getTime(),
        timestampLabel: entry.timestamp
          ? entry.timestamp.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
          : '',
        compaction: entry.compaction ? {
          timestamp: entry.compaction.timestamp.getTime(),
          tokensBefore: entry.compaction.tokensBefore,
          tokensAfter: entry.compaction.tokensAfter,
          trigger: entry.compaction.trigger,
          source: entry.compaction.source,
          summary: entry.compaction.summary,
        } : undefined,
      }));
      const delta = applyDelta(transcript, req.sinceId);
      return { sessionKey, ...delta };
    }
  }
  return { sessionKey, entries: [], replace: true };
}

function applyDelta(entries: MobileTranscriptEntry[], sinceId?: string): {
  entries: MobileTranscriptEntry[];
  replace?: boolean;
} {
  if (!sinceId) return { entries };
  const idx = entries.findIndex((e) => e.id === sinceId);
  if (idx === -1) {
    return {
      entries,
      replace: true,
    };
  }
  return { entries: entries.slice(idx + 1) };
}

// ── Review file resolver ──

const reviewFileCache = new Map<string, { data: unknown; timestamp: number }>();
const REVIEW_FILE_CACHE_TTL = 10000;

async function resolveReviewFile(filePath: string): Promise<unknown> {
  const cached = reviewFileCache.get(filePath);
  if (cached && Date.now() - cached.timestamp < REVIEW_FILE_CACHE_TTL) {
    return cached.data;
  }
  const file = await getReviewFileDetail(filePath);
  reviewFileCache.set(filePath, { data: file, timestamp: Date.now() });
  return file;
}

// ── Main handler ──

export async function POST(request: NextRequest) {
  const startedAt = performance.now();
  let body: SyncRequest;
  try {
    body = (await request.json()) as SyncRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid or empty request body' }, { status: 400 });
  }
  const errors: Record<string, string> = {};

  // Resolve ALL requested sections in parallel — one failure doesn't block others
  const [inboxResult, historyResult, reviewResult, linkedResult] = await Promise.all([
    body.inbox
      ? resolveInbox(body.inbox).catch((e: unknown) => {
          errors.inbox = e instanceof Error ? e.message : 'inbox failed';
          return null;
        })
      : null,
    body.history?.sessionKey
      ? resolveHistory(body.history).catch((e: unknown) => {
          errors.history = e instanceof Error ? e.message : 'history failed';
          return null;
        })
      : null,
    body.review?.includeFile
      ? resolveReviewFile(body.review.includeFile).catch((e: unknown) => {
          errors.review = e instanceof Error ? e.message : 'review failed';
          return null;
        })
      : null,
    body.linked?.sessionKey
      ? resolveHistory({ sessionKey: body.linked.sessionKey, sinceId: body.linked.sinceId, limit: 18 }).catch((e: unknown) => {
          errors.linked = e instanceof Error ? e.message : 'linked failed';
          return null;
        })
      : null,
  ]);

  const response: SyncResponse = { serverTime: new Date().toISOString() };

  if (inboxResult) {
    response.inbox = inboxResult.snapshot;
    response.inboxEtag = inboxResult.etag;
  }
  if (historyResult) {
    response.history = historyResult;
  }
  if (reviewResult !== null && reviewResult !== undefined) {
    response.review = { file: reviewResult };
  }
  if (linkedResult) {
    response.linked = linkedResult;
  }
  if (Object.keys(errors).length > 0) {
    response.errors = errors;
  }

  return NextResponse.json(response, {
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}`,
    },
  });
}
