export const dynamic = 'force-dynamic';

/**
 * GET/POST/DELETE /api/v2/chat-history — persist LLM chat messages per tab
 *
 * Stored at ~/.cortex-ide/chat-history/{tabId}.json
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HISTORY_DIR = join(homedir(), '.cortex-ide', 'chat-history');

function ensureDir() {
  mkdirSync(HISTORY_DIR, { recursive: true });
}

function safePath(tabId: string): string {
  // Sanitize tab ID to prevent path traversal
  const safe = tabId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(HISTORY_DIR, `${safe}.json`);
}

export async function GET(request: NextRequest) {
  const tabId = request.nextUrl.searchParams.get('tabId');
  if (!tabId) return NextResponse.json({ error: 'tabId required' }, { status: 400 });

  const filePath = safePath(tabId);
  try {
    const data = readFileSync(filePath, 'utf-8');
    return NextResponse.json(JSON.parse(data));
  } catch {
    return NextResponse.json(null, { status: 404 });
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

  // Preserve starred status from existing file
  let starred = false;
  try {
    const existing = JSON.parse(readFileSync(filePath, 'utf-8'));
    starred = existing.starred || false;
  } catch { /* new file */ }

  writeFileSync(filePath, JSON.stringify({
    messages,
    model: body.model,
    savedAt: new Date().toISOString(),
    starred: body.starred ?? starred,
  }));

  return NextResponse.json({ ok: true });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body?.tabId) return NextResponse.json({ error: 'tabId required' }, { status: 400 });

  const filePath = safePath(body.tabId);
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (body.starred !== undefined) data.starred = body.starred;
    if (body.title !== undefined) data.title = body.title;
    writeFileSync(filePath, JSON.stringify(data));
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}

export async function DELETE(request: NextRequest) {
  const tabId = request.nextUrl.searchParams.get('tabId');
  if (!tabId) return NextResponse.json({ error: 'tabId required' }, { status: 400 });

  const filePath = safePath(tabId);
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch { /* ignore */ }
  return NextResponse.json({ ok: true });
}
