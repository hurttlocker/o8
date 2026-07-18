import { NextRequest, NextResponse } from 'next/server';
import { archiveOwnedCodexSession, ownedCodexSessionState } from '@/lib/codex/owned';
import { ownedCursorSessionState } from '@/lib/cursor/owned';
import { archiveOwnedGeminiSession, ownedGeminiSessionState } from '@/lib/gemini/owned';
import { ownedGrokSessionState } from '@/lib/grok/owned';
import { archiveOwnedOpencodeSession, ownedOpencodeSessionState } from '@/lib/opencode/owned';
import { invalidateRuntimeInventoryCache } from '@/lib/runtime/inventory';
import type { OwnedSessionState } from '@/lib/runtimes/shared/owned-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

async function readOwnedSessionState(sessionKey: string): Promise<OwnedSessionState> {
  try {
    if (sessionKey.startsWith('codex-owned:')) return await ownedCodexSessionState(sessionKey);
    if (sessionKey.startsWith('gemini-owned:')) return await ownedGeminiSessionState(sessionKey);
    if (sessionKey.startsWith('opencode-owned:')) return await ownedOpencodeSessionState(sessionKey);
    if (sessionKey.startsWith('cursor-owned:')) return await ownedCursorSessionState(sessionKey);
    if (sessionKey.startsWith('grok-owned:')) return await ownedGrokSessionState(sessionKey);
    return 'active';
  } catch {
    return 'active';
  }
}

export async function GET(request: NextRequest) {
  const sessionKeys = Array.from(new Set(
    (request.nextUrl.searchParams.get('sessionKeys') ?? '')
      .split(',')
      .map((sessionKey) => sessionKey.trim())
      .filter(Boolean),
  )).slice(0, 100);
  const entries = await Promise.all(sessionKeys.map(async (sessionKey) => (
    [sessionKey, await readOwnedSessionState(sessionKey)] as const
  )));
  return NextResponse.json({ states: Object.fromEntries(entries) }, { headers: NO_STORE });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { sessionKey?: string } | null;
  const sessionKey = body?.sessionKey?.trim();
  if (!sessionKey) {
    return NextResponse.json({ error: 'sessionKey is required' }, { status: 400, headers: NO_STORE });
  }

  try {
    let result: { archived: boolean; note: string; archivePath?: string };
    if (sessionKey.startsWith('codex-owned:')) {
      result = await archiveOwnedCodexSession(sessionKey);
    } else if (sessionKey.startsWith('gemini-owned:')) {
      result = await archiveOwnedGeminiSession(sessionKey);
    } else if (sessionKey.startsWith('opencode-owned:')) {
      result = await archiveOwnedOpencodeSession(sessionKey);
    } else {
      return NextResponse.json(
        { error: `Archive is only supported for owned runtime sessions. Got prefix: ${sessionKey.split(':')[0]}` },
        { status: 400, headers: NO_STORE },
      );
    }

    invalidateRuntimeInventoryCache();
    return NextResponse.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to archive session.';
    return NextResponse.json({ error: message }, { status: 500, headers: NO_STORE });
  }
}
