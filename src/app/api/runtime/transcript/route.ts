import { NextRequest, NextResponse } from 'next/server';
import '@/lib/runtimes'; // Ensure runtimes are registered
import { getRuntime } from '@/lib/runtimes/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function runtimeIdFromSessionKey(sessionKey: string): string | null {
  if (sessionKey.startsWith('claude-code:')) return 'claude-code';
  if (sessionKey.startsWith('codex:') || sessionKey.startsWith('codex-owned:') || sessionKey.startsWith('codex-discovered:')) return 'codex';
  return null;
}

export async function GET(request: NextRequest) {
  const sessionKey = request.nextUrl.searchParams.get('sessionKey');
  if (!sessionKey) {
    return NextResponse.json({ error: 'sessionKey is required' }, { status: 400 });
  }

  const limit = parseInt(request.nextUrl.searchParams.get('limit') ?? '20', 10);
  const sinceId = request.nextUrl.searchParams.get('sinceId') ?? undefined;

  const runtimeId = runtimeIdFromSessionKey(sessionKey);
  if (!runtimeId) {
    return NextResponse.json({ error: `Cannot determine runtime for session: ${sessionKey}` }, { status: 400 });
  }

  const adapter = getRuntime(runtimeId);
  if (!adapter || !adapter.capabilities.readTranscript) {
    return NextResponse.json({ error: `Runtime ${runtimeId} does not support transcript reading` }, { status: 400 });
  }

  try {
    const entries = await adapter.readTranscript(sessionKey, sinceId, limit);
    const transcript = entries.map((entry) => ({
      id: entry.id,
      role: entry.role,
      text: entry.text,
      type: entry.type ?? 'message',
      timestamp: entry.timestamp.getTime(),
      timestampLabel: entry.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      toolName: entry.toolName,
      filePath: entry.filePath,
      compaction: entry.compaction ? {
        timestamp: entry.compaction.timestamp.getTime(),
        tokensBefore: entry.compaction.tokensBefore,
        tokensAfter: entry.compaction.tokensAfter,
        trigger: entry.compaction.trigger,
        source: entry.compaction.source,
        summary: entry.compaction.summary,
      } : undefined,
    }));
    return NextResponse.json({ transcript }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to read transcript' },
      { status: 500 },
    );
  }
}
