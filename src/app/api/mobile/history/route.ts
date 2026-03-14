import { NextRequest, NextResponse } from 'next/server';
import { getOwnedCodexRuntimeTail } from '@/lib/codex/owned';
import { getCodexRuntimeTail } from '@/lib/codex/sessions';
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

    // Discovered Codex sessions — read JSONL tail from ~/.codex/sessions/
    if (sessionKey.startsWith('codex:')) {
      const tail = await getCodexRuntimeTail(sessionKey);
      const transcript: MobileTranscriptEntry[] = [];
      for (const entry of tail.entries ?? []) {
        // Skip noisy system/instruction entries — only show user, assistant, and tool activity
        if (entry.kind === 'event' && entry.label === 'Agent update') {
          // Agent updates are assistant messages
          transcript.push({ id: entry.id, role: 'assistant', text: entry.text, timestampLabel: entry.timestampLabel });
          continue;
        }
        if (entry.kind === 'message') {
          const role = runtimeTailRole(entry.label);
          // Filter out system instructions (permissions, collaboration mode, AGENTS.md)
          if (role === 'system' || role === 'user') {
            const lowerText = entry.text.toLowerCase();
            if (lowerText.includes('<permissions') || lowerText.includes('collaboration_mode') || lowerText.includes('# agents.md') || lowerText.includes('sandbox_mode')) continue;
          }
          transcript.push({ id: entry.id, role, text: entry.text, timestampLabel: entry.timestampLabel });
          continue;
        }
        if (entry.kind === 'tool') {
          // Format tool calls as system entries with clean names
          const toolName = entry.label || 'Tool';
          transcript.push({ id: entry.id, role: 'system', text: `🔧 ${toolName}`, timestampLabel: entry.timestampLabel });
          continue;
        }
        if (entry.kind === 'tool-output') {
          // Show compact tool output
          transcript.push({ id: entry.id, role: 'system', text: entry.text, timestampLabel: entry.timestampLabel });
          continue;
        }
      }
      // Deduplicate consecutive assistant messages with identical text
      const deduped: MobileTranscriptEntry[] = [];
      for (const entry of transcript) {
        const prev = deduped[deduped.length - 1];
        if (prev && prev.role === 'assistant' && entry.role === 'assistant' && prev.text === entry.text) continue;
        deduped.push(entry);
      }
      const payload: MobileHistoryResponse = { sessionKey, transcript: deduped };
      return NextResponse.json(payload, {
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }

    // OpenClaw sessions — use gateway chat.history
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
