import { NextRequest, NextResponse } from 'next/server';
import { archiveOwnedCodexSession } from '@/lib/codex/owned';
import { archiveOwnedGeminiSession } from '@/lib/gemini/owned';
import { archiveOwnedOpencodeSession } from '@/lib/opencode/owned';
import { invalidateRuntimeInventoryCache } from '@/lib/runtime/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

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
