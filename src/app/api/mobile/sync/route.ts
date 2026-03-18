import { NextRequest, NextResponse } from 'next/server';
import { getOwnedCodexRuntimeTail } from '@/lib/codex/owned';
import { getCodexRuntimeTail } from '@/lib/codex/sessions';
import type { MobileInboxSnapshot, MobileTranscriptEntry } from '@/lib/mobile/types';
import { getMobileInboxSnapshot } from '@/lib/mobile/openclaw';
import { getSessionTranscript } from '@/lib/openclaw/chat';
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
  history?: { sessionKey: string; entries: MobileTranscriptEntry[] };
  review?: { file?: unknown };
  linked?: { sessionKey: string; entries: MobileTranscriptEntry[] };
  serverTime: string;
  errors?: Record<string, string>;
}

// ── Inbox cache with ETag ──

let inboxCache: { snapshot: MobileInboxSnapshot; etag: string; timestamp: number } | null = null;
const INBOX_CACHE_TTL = 5000;

function computeEtag(snapshot: MobileInboxSnapshot): string {
  const sig = snapshot.sessions
    .map((s) => `${s.id}:${s.status}:${s.lastEventAt ?? ''}:${Math.round(s.context?.usedPercent ?? 0)}`)
    .join('|');
  let hash = 0;
  for (let i = 0; i < sig.length; i++) {
    hash = ((hash << 5) - hash + sig.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

async function resolveInbox(req: SyncRequest['inbox']): Promise<{ snapshot: MobileInboxSnapshot | null; etag: string }> {
  const now = Date.now();
  if (!inboxCache || now - inboxCache.timestamp > INBOX_CACHE_TTL) {
    const snapshot = await getMobileInboxSnapshot();
    const etag = computeEtag(snapshot);
    inboxCache = { snapshot, etag, timestamp: now };
  }

  if (req?.etag && req.etag === inboxCache.etag) {
    return { snapshot: null, etag: inboxCache.etag };
  }
  return { snapshot: inboxCache.snapshot, etag: inboxCache.etag };
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
): Promise<{ sessionKey: string; entries: MobileTranscriptEntry[] }> {
  const { sessionKey, limit: rawLimit } = req;
  const limit = Math.min(Math.max(rawLimit ?? 18, 1), 40);

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
    return { sessionKey, entries: applyDelta(entries, req.sinceId) };
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
    return { sessionKey, entries: applyDelta(deduped, req.sinceId) };
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
        timestampLabel: entry.timestamp
          ? entry.timestamp.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
          : '',
      }));
      return { sessionKey, entries: applyDelta(transcript, req.sinceId) };
    }
  }

  // OpenClaw sessions
  const transcript = await getSessionTranscript(sessionKey, limit);
  return { sessionKey, entries: applyDelta(transcript, req.sinceId) };
}

function applyDelta(entries: MobileTranscriptEntry[], sinceId?: string): MobileTranscriptEntry[] {
  if (!sinceId) return entries;
  const idx = entries.findIndex((e) => e.id === sinceId);
  if (idx === -1) return entries; // sinceId not found — return all
  return entries.slice(idx + 1);
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
  const body = (await request.json()) as SyncRequest;
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
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
