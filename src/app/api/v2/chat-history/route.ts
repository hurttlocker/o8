export const dynamic = 'force-dynamic';

/**
 * GET/POST/DELETE /api/v2/chat-history — persist LLM chat messages per tab
 *
 * Stored at ~/.o8/chat-history/{tabId}.json
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { extractPlanFromTranscript } from '@/lib/llm/plan-extractor';

const HISTORY_DIR = join(homedir(), '.o8', 'chat-history');

function ensureDir() {
  mkdirSync(HISTORY_DIR, { recursive: true });
}

function safePath(tabId: string): string {
  // Sanitize tab ID to prevent path traversal
  const safe = tabId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(HISTORY_DIR, `${safe}.json`);
}

function normalizePlanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeNullableDate(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** The orchestrator backend that produced this thread, if the client tagged it. */
function normalizeBackend(value: unknown): 'codex' | 'claude' | 'openclaw' | undefined {
  return value === 'codex' || value === 'claude' || value === 'openclaw' ? value : undefined;
}

/** The openclaw agent id that produced this thread, if the client tagged it. */
function normalizeAgent(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 128) : undefined;
}

function normalizeSessionIds(value: unknown): Record<string, string | null> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const normalized: Record<string, string | null> = {};
  for (const [key, rawSessionId] of Object.entries(value as Record<string, unknown>)) {
    if (!key) continue;
    if (rawSessionId === null) {
      normalized[key] = null;
      continue;
    }
    if (typeof rawSessionId !== 'string') continue;
    const sessionId = rawSessionId.trim();
    if (sessionId) normalized[key] = sessionId;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export async function GET(request: NextRequest) {
  const tabId = request.nextUrl.searchParams.get('tabId');
  if (!tabId) return NextResponse.json({ error: 'tabId required' }, { status: 400 });

  const filePath = safePath(tabId);
  try {
    const data = readFileSync(filePath, 'utf-8');
    return NextResponse.json(JSON.parse(data));
  } catch {
    return NextResponse.json({
      messages: [],
      model: null,
      savedAt: null,
      starred: false,
      title: null,
      planText: null,
      repoName: null,
      repoPath: null,
      repoBranch: null,
      remoteUrl: null,
      backend: null,
      agent: null,
      archivedAt: null,
      orchestratorSessionIds: null,
      orchestratorSessionUpdatedAt: null,
      exists: false,
    });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body?.tabId || !body?.messages) {
    return NextResponse.json({ error: 'tabId and messages required' }, { status: 400 });
  }

  ensureDir();
  const filePath = safePath(body.tabId);

  // Don't save images in history (too large) — strip data URIs
  const messages = body.messages.map((m: Record<string, unknown>) => ({
    ...m,
    images: undefined, // strip image data URIs from persistence
    // Strip data URIs from content too (they'd be huge)
    content: typeof m.content === 'string'
      ? (m.content as string).replace(/!\[[^\]]*\]\(data:[^)]+\)/g, '[image]')
      : m.content,
  }));
  const extractedPlanText = extractPlanFromTranscript(messages.map((m: Record<string, unknown>) => ({
    role: typeof m.role === 'string' ? m.role : undefined,
    content: m.content,
    toolCalls: m.toolCalls,
  })));

  // Preserve starred status from existing file
  let starred = false;
  let pinned = false;
  let title: string | undefined;
  let planText: string | undefined;
  let repoName: string | undefined;
  let repoPath: string | undefined;
  let repoBranch: string | undefined;
  let remoteUrl: string | null | undefined;
  let backend: 'codex' | 'claude' | 'openclaw' | undefined;
  let agent: string | undefined;
  let archivedAt: string | null | undefined;
  let orchestratorVisible: boolean | undefined;
  let mobileCreatedAt: string | null | undefined;
  let mobileRevealRequestedAt: string | null | undefined;
  let orchestratorSessionIds: Record<string, string | null> | undefined;
  let orchestratorSessionUpdatedAt: string | null | undefined;
  try {
    const existing = JSON.parse(readFileSync(filePath, 'utf-8'));
    starred = existing.starred || false;
    pinned = existing.pinned === true;
    title = existing.title;
    planText = normalizePlanText(existing.planText);
    repoName = existing.repoName;
    repoPath = existing.repoPath;
    repoBranch = existing.repoBranch;
    remoteUrl = existing.remoteUrl;
    backend = normalizeBackend(existing.backend);
    agent = normalizeAgent(existing.agent);
    archivedAt = normalizeNullableDate(existing.archivedAt);
    orchestratorVisible = existing.orchestratorVisible === true ? true : undefined;
    mobileCreatedAt = normalizeNullableDate(existing.mobileCreatedAt);
    mobileRevealRequestedAt = normalizeNullableDate(existing.mobileRevealRequestedAt);
    orchestratorSessionIds = normalizeSessionIds(existing.orchestratorSessionIds);
    orchestratorSessionUpdatedAt = normalizeNullableDate(existing.orchestratorSessionUpdatedAt);
  } catch { /* new file */ }
  const nextArchivedAt = body.archivedAt !== undefined
    ? normalizeNullableDate(body.archivedAt) ?? null
    : archivedAt ?? null;

  writeFileSync(filePath, JSON.stringify({
    messages,
    model: body.model,
    savedAt: new Date().toISOString(),
    starred: body.starred ?? starred,
    pinned: body.pinned ?? pinned,
    title: body.title ?? title,
    planText: normalizePlanText(body.planText) ?? planText ?? extractedPlanText,
    repoName: body.repoName ?? repoName,
    repoPath: body.repoPath ?? repoPath,
    repoBranch: body.repoBranch ?? repoBranch,
    remoteUrl: body.remoteUrl ?? remoteUrl ?? null,
    backend: normalizeBackend(body.backend) ?? backend ?? null,
    agent: normalizeAgent(body.agent) ?? agent ?? null,
    archivedAt: nextArchivedAt,
    orchestratorVisible,
    mobileCreatedAt,
    mobileRevealRequestedAt,
    orchestratorSessionIds: normalizeSessionIds(body.orchestratorSessionIds) ?? orchestratorSessionIds ?? {},
    orchestratorSessionUpdatedAt: normalizeNullableDate(body.orchestratorSessionUpdatedAt) ?? orchestratorSessionUpdatedAt ?? null,
  }));

  return NextResponse.json({ ok: true });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body?.tabId) return NextResponse.json({ error: 'tabId required' }, { status: 400 });

  ensureDir();
  const filePath = safePath(body.tabId);

  // Upsert — if the chat hasn't been saved yet (no messages have flowed
  // through POST), create a metadata-only record. Lets the operator
  // rename / archive / pin a fresh chat without having to send a message
  // first.
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    data = {
      messages: [],
      savedAt: new Date().toISOString(),
      starred: false,
    };
  }

  if (body.starred !== undefined) data.starred = body.starred;
  if (body.pinned !== undefined) data.pinned = body.pinned;
  if (body.title !== undefined) data.title = body.title;
  if (body.planText !== undefined) data.planText = normalizePlanText(body.planText) ?? null;
  if (body.repoName !== undefined) data.repoName = body.repoName;
  if (body.repoPath !== undefined) data.repoPath = body.repoPath;
  if (body.repoBranch !== undefined) data.repoBranch = body.repoBranch;
  if (body.remoteUrl !== undefined) data.remoteUrl = body.remoteUrl;
  if (body.backend !== undefined) data.backend = normalizeBackend(body.backend) ?? null;
  if (body.agent !== undefined) data.agent = normalizeAgent(body.agent) ?? null;
  if (body.archivedAt !== undefined) data.archivedAt = normalizeNullableDate(body.archivedAt) ?? null;
  if (body.orchestratorSessionIds !== undefined) data.orchestratorSessionIds = normalizeSessionIds(body.orchestratorSessionIds) ?? {};
  if (body.orchestratorSessionUpdatedAt !== undefined) {
    data.orchestratorSessionUpdatedAt = normalizeNullableDate(body.orchestratorSessionUpdatedAt) ?? null;
  }

  writeFileSync(filePath, JSON.stringify(data));
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const tabId = request.nextUrl.searchParams.get('tabId');
  if (!tabId) return NextResponse.json({ error: 'tabId required' }, { status: 400 });

  const filePath = safePath(tabId);
  if (!existsSync(filePath)) {
    // Idempotent — already gone is still a success.
    return NextResponse.json({ ok: true });
  }
  try {
    unlinkSync(filePath);
    return NextResponse.json({ ok: true });
  } catch (error) {
    // Surface the actual failure so the client can show a toast and
    // skip the optimistic UI removal. Silent-catch + 200 OK used to
    // make the deleted item reappear after the next list refetch.
    const message = error instanceof Error ? error.message : 'unlink failed';
    console.error('[chat-history] DELETE failed', { tabId, message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
