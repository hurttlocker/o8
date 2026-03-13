import { NextRequest, NextResponse } from 'next/server';
import { getOwnedCodexRuntimeTail } from '@/lib/codex/owned';
import type { MobileHistoryResponse, MobileTranscriptEntry } from '@/lib/mobile/types';
import { getSessionTranscript } from '@/lib/openclaw/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function runtimeTailRole(label: string): MobileTranscriptEntry['role'] {
  const normalized = label.toLowerCase();
  if (normalized.includes('assistant')) return 'assistant';
  if (normalized.includes('user')) return 'user';
  if (normalized.includes('tool')) return 'tool';
  return 'system';
}

export async function GET(request: NextRequest) {
  const sessionKey = request.nextUrl.searchParams.get('sessionKey')?.trim();
  const rawLimit = request.nextUrl.searchParams.get('limit');
  const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : 6;
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 20) : 6;

  if (!sessionKey) {
    return NextResponse.json({ error: 'sessionKey is required' }, { status: 400 });
  }

  try {
    if (sessionKey.startsWith('codex-owned:')) {
      const tail = await getOwnedCodexRuntimeTail(sessionKey);
      const payload: MobileHistoryResponse = {
        sessionKey,
        transcript: (tail.entries ?? []).map((entry) => ({
          id: entry.id,
          role: runtimeTailRole(entry.label),
          text: entry.text,
          timestampLabel: entry.timestampLabel,
        })),
        groups: (tail.groups ?? []).map((group) => ({
          id: group.id,
          title: group.title,
          mode: group.mode,
          outcome: group.outcome,
          prompt: group.prompt,
          startedAt: group.startedAt,
          finishedAt: group.finishedAt,
          startedAtLabel: group.startedAtLabel,
          finishedAtLabel: group.finishedAtLabel,
          summary: group.summary,
          entries: group.entries.map((entry) => ({
            id: entry.id,
            role: runtimeTailRole(entry.label),
            text: entry.text,
            timestampLabel: entry.timestampLabel,
          })),
        })),
      };

      return NextResponse.json(payload, {
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      });
    }

    const transcript = await getSessionTranscript(sessionKey, limit);
    const payload: MobileHistoryResponse = {
      sessionKey,
      transcript,
    };

    return NextResponse.json(payload, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to load mobile session history',
      },
      { status: 500 },
    );
  }
}
