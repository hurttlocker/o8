import { NextRequest, NextResponse } from 'next/server';
import { getCodexRuntimeTail, type RuntimeTailEntry } from '@/lib/codex/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CodexTranscriptEntry = {
  id: string;
  role: 'assistant' | 'system';
  text: string;
  timestampLabel: string;
};

function mapCodexEntry(entry: RuntimeTailEntry): CodexTranscriptEntry | null {
  const text = entry.text.trim();
  const timestampLabel = entry.timestampLabel ?? '';

  if (entry.kind === 'message') {
    if (!text) return null;
    return {
      id: entry.id,
      role: 'assistant',
      text,
      timestampLabel,
    };
  }

  if (entry.kind === 'tool') {
    const prefix = `🔧 ${entry.label || 'Tool'}`;
    return {
      id: entry.id,
      role: 'assistant',
      text: text ? `${prefix}\n${text}` : prefix,
      timestampLabel,
    };
  }

  if (entry.kind === 'event') {
    if (!text) return null;
    return {
      id: entry.id,
      role: 'system',
      text,
      timestampLabel,
    };
  }

  return null;
}

export async function GET(req: NextRequest) {
  const sessionKey = req.nextUrl.searchParams.get('sessionKey') ?? '';
  const limit = parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10);

  if (!sessionKey.startsWith('codex:')) {
    return NextResponse.json({ transcript: [] });
  }

  const threadId = sessionKey.slice('codex:'.length).trim();
  if (!threadId) {
    return NextResponse.json({ transcript: [] });
  }

  try {
    const tail = await getCodexRuntimeTail(`codex:${threadId}`);
    const transcript = (tail.entries ?? [])
      .map(mapCodexEntry)
      .filter((entry): entry is CodexTranscriptEntry => Boolean(entry))
      .slice(-Math.max(Number.isFinite(limit) ? limit : 50, 1));

    return NextResponse.json(
      { transcript },
      {
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      },
    );
  } catch (err) {
    return NextResponse.json(
      { transcript: [], error: err instanceof Error ? err.message : 'unknown' },
      { status: 500 },
    );
  }
}
