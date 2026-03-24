import { NextRequest, NextResponse } from 'next/server';
import { getCodexRuntimeTail, type RuntimeTailEntry } from '@/lib/codex/sessions';
import type { MobileTranscriptToolCall } from '@/lib/mobile/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CodexTranscriptEntry = {
  id: string;
  role: 'assistant' | 'system';
  text: string;
  timestampLabel: string;
  toolCalls?: MobileTranscriptToolCall[];
};

function parseToolArgs(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { input: parsed };
  } catch {
    return { input: trimmed };
  }
}

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
    return {
      id: entry.id,
      role: 'assistant',
      text: '',
      timestampLabel,
      toolCalls: [{
        name: entry.label || 'tool',
        args: parseToolArgs(text),
        status: 'done',
      }],
    };
  }

  if (entry.kind === 'event') {
    if (entry.label === 'Agent update') {
      return null;
    }
    if (!text) return null;
    return {
      id: entry.id,
      role: 'system',
      text,
      timestampLabel,
    };
  }

  if (entry.kind === 'tool-output') {
    return null;
  }

  return null;
}

export async function GET(req: NextRequest) {
  const sessionKey = req.nextUrl.searchParams.get('sessionKey') ?? '';
  const limit = parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10);

  if (!sessionKey.startsWith('codex:') && !sessionKey.startsWith('codex-live:')) {
    return NextResponse.json({ transcript: [] });
  }

  const runtimeKey = sessionKey.startsWith('codex-live:') ? sessionKey : `codex:${sessionKey.slice('codex:'.length).trim()}`;
  if (runtimeKey === 'codex:' || runtimeKey === 'codex-live:') {
    return NextResponse.json({ transcript: [] });
  }

  try {
    const tail = await getCodexRuntimeTail(runtimeKey);
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
