import { NextRequest, NextResponse } from 'next/server';
import { archiveOwnedCodexSession, ownedCodexSessionState } from '@/lib/codex/owned';
import { ownedCursorSessionState } from '@/lib/cursor/owned';
import { archiveOwnedGeminiSession, ownedGeminiSessionState } from '@/lib/gemini/owned';
import { ownedGrokSessionState } from '@/lib/grok/owned';
import { archiveOwnedOpencodeSession, ownedOpencodeSessionState } from '@/lib/opencode/owned';
import { archiveLane, getLane } from '@/lib/lane/registry';
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
  const body = (await request.json().catch(() => null)) as { sessionKey?: string; laneId?: string } | null;
  const sessionKey = body?.sessionKey?.trim();
  const laneId = body?.laneId?.trim();
  if (!sessionKey && !laneId) {
    return NextResponse.json({ error: 'sessionKey or laneId is required' }, { status: 400, headers: NO_STORE });
  }
  if (sessionKey && laneId) {
    return NextResponse.json({ error: 'Pass sessionKey or laneId, not both' }, { status: 400, headers: NO_STORE });
  }

  if (laneId) {
    const lane = getLane(laneId);
    if (!lane) {
      return NextResponse.json({ error: `Lane ${laneId} was not found` }, { status: 404, headers: NO_STORE });
    }
    if (lane.sessionKey) {
      return NextResponse.json(
        { error: 'This lane has an owned session; archive it with sessionKey so the runtime state is preserved.' },
        { status: 409, headers: NO_STORE },
      );
    }
    if (lane.status !== 'failed' && lane.status !== 'completed' && lane.status !== 'archived') {
      return NextResponse.json(
        { error: `Lane ${laneId} is ${lane.status}; only terminal sessionless lanes can be archived.` },
        { status: 409, headers: NO_STORE },
      );
    }

    const archived = archiveLane(laneId, 'user');
    if (!archived) {
      return NextResponse.json({ error: `Lane ${laneId} was not found` }, { status: 404, headers: NO_STORE });
    }
    invalidateRuntimeInventoryCache();
    return NextResponse.json({
      ok: true,
      archived: true,
      laneId,
      note: 'Sessionless terminal lane archived.',
    }, { headers: NO_STORE });
  }

  try {
    const ownedSessionKey = sessionKey!;
    let result: { archived: boolean; note: string; archivePath?: string };
    if (ownedSessionKey.startsWith('codex-owned:')) {
      result = await archiveOwnedCodexSession(ownedSessionKey);
    } else if (ownedSessionKey.startsWith('gemini-owned:')) {
      result = await archiveOwnedGeminiSession(ownedSessionKey);
    } else if (ownedSessionKey.startsWith('opencode-owned:')) {
      result = await archiveOwnedOpencodeSession(ownedSessionKey);
    } else {
      return NextResponse.json(
        { error: `Archive is only supported for owned runtime sessions. Got prefix: ${ownedSessionKey.split(':')[0]}` },
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
