import { NextRequest, NextResponse } from 'next/server';
import { readRuntimeTranscript } from '@/lib/runtime/transcript';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const sessionKey = request.nextUrl.searchParams.get('sessionKey');
  if (!sessionKey) {
    return NextResponse.json({ error: 'sessionKey is required' }, { status: 400 });
  }

  const limit = parseInt(request.nextUrl.searchParams.get('limit') ?? '20', 10);
  const sinceId = request.nextUrl.searchParams.get('sinceId') ?? undefined;

  try {
    const entries = await readRuntimeTranscript(sessionKey, { sinceId, limit });
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
    const message = error instanceof Error ? error.message : 'Unable to read transcript';
    const status = message.startsWith('Cannot determine runtime') || message.includes('does not support transcript reading')
      ? 400
      : 500;
    return NextResponse.json(
      { error: message },
      { status },
    );
  }
}
