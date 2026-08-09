import { NextRequest, NextResponse } from 'next/server';
import { getOwnedCodexRuntimeTail } from '@/lib/codex/owned';
import { getCodexRuntimeTail } from '@/lib/codex/sessions';
import { getOwnedGeminiRuntimeTail } from '@/lib/gemini/owned';
import { getOwnedOpencodeRuntimeTail } from '@/lib/opencode/owned';
import { getOwnedCursorRuntimeTail } from '@/lib/cursor/owned';
import { getOwnedGrokRuntimeTail } from '@/lib/grok/owned';
import { loadMobileLlmChatHistory } from '@/lib/llm/mobile-llm-chat';
import type { MobileHistoryResponse, MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';
import '@/lib/runtimes'; // Ensure runtimes are registered
import { readSessionHuddleTranscriptEvents, readSessionSteerTranscriptEvents } from '@/lib/orchestrator/packet-transcript';
import { getRuntime } from '@/lib/runtimes/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function runtimeTailRole(label: string): MobileTranscriptEntry['role'] {
  const normalized = label.toLowerCase();
  if (normalized.includes('assistant')) return 'assistant';
  if (normalized.includes('user')) return 'user';
  if (normalized.includes('tool')) return 'tool';
  return 'system';
}

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

function toolCallFromEntry(name: string, text: string): MobileTranscriptToolCall {
  return {
    name: name || 'tool',
    args: parseToolArgs(text),
    status: 'done',
  };
}

function appendSteerEntries(sessionKey: string, transcript: MobileTranscriptEntry[]): MobileTranscriptEntry[] {
  const steerEvents = readSessionSteerTranscriptEvents(sessionKey);
  const huddleEvents = readSessionHuddleTranscriptEvents(sessionKey);
  if (steerEvents.length === 0 && huddleEvents.length === 0) return transcript;
  const huddleEntries = huddleEvents.map((event) => {
    const timestamp = new Date(event.ts);
    const timestampMs = Number.isFinite(timestamp.getTime()) ? timestamp.getTime() : Date.now();
    const timestampLabel = new Date(timestampMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return {
      id: `huddle-${event.seq}`,
      role: 'assistant' as const,
      text: `Huddling — plan posted\n\n${event.text}`,
      timestamp: timestampMs,
      timestampLabel,
    };
  });
  const steerEntries = steerEvents.map((event) => {
    const timestamp = new Date(event.ts);
    const timestampMs = Number.isFinite(timestamp.getTime()) ? timestamp.getTime() : Date.now();
    const timestampLabel = new Date(timestampMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return {
      id: `steer-${event.seq}`,
      role: 'user' as const,
      text: `${event.failed ? 'Steer failed to start' : event.source} · ${timestampLabel}\n\n${event.text}${event.note && event.note !== event.text ? `\n\n${event.note}` : ''}`,
      timestamp: timestampMs,
      timestampLabel,
    };
  });
  return [...transcript, ...huddleEntries, ...steerEntries].sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));
}

export async function GET(request: NextRequest) {
  const sessionKey = request.nextUrl.searchParams.get('sessionKey')?.trim();
  const rawLimit = request.nextUrl.searchParams.get('limit');
  const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : 6;
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 6;

  if (!sessionKey) {
    return NextResponse.json({ error: 'sessionKey is required' }, { status: 400 });
  }

  try {
    if (sessionKey.startsWith('llm-chat:')) {
      return NextResponse.json(loadMobileLlmChatHistory(sessionKey, limit), {
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      });
    }

    // Owned CLI sessions — identical tail shape
    // since they share the owned-session-store primitive. Build a chat-style
    // flat transcript for any of the three owned prefixes.
    const ownedMatch =
      sessionKey.startsWith('codex-owned:') ? { tail: await getOwnedCodexRuntimeTail(sessionKey), kind: 'codex' as const }
      : sessionKey.startsWith('gemini-owned:') ? { tail: await getOwnedGeminiRuntimeTail(sessionKey), kind: 'gemini' as const }
      : sessionKey.startsWith('opencode-owned:') ? { tail: await getOwnedOpencodeRuntimeTail(sessionKey), kind: 'opencode' as const }
      : sessionKey.startsWith('cursor-owned:') ? { tail: await getOwnedCursorRuntimeTail(sessionKey), kind: 'cursor' as const }
      : sessionKey.startsWith('grok-owned:') ? { tail: await getOwnedGrokRuntimeTail(sessionKey), kind: 'grok' as const }
      : null;

    if (ownedMatch) {
      const { tail, kind } = ownedMatch;
      const chatTranscript: MobileTranscriptEntry[] = [];
      const groups = tail.groups ?? [];

      // Runtime-specific noise markers — usage stats + launch/resume echoes.
      const noiseMarkers =
        kind === 'codex' ? ['Usage •', 'Owned Codex session', 'Codex run launched']
        : kind === 'gemini' ? ['Usage •', 'Owned Gemini session', 'Gemini run launched', 'Rate limited', 'Silent exit']
        : kind === 'cursor' ? ['Usage •', 'Owned Cursor session', 'Cursor run launched']
        : kind === 'grok' ? ['Usage •', 'Owned Grok Build session', 'Grok run launched']
        : ['Usage •', 'Owned OpenCode 2 session', 'opencode2 run launched'];

      for (const group of groups) {
        const pendingToolCalls: MobileTranscriptToolCall[] = [];
        const promptText = group.prompt?.trim();
        if (promptText) {
          chatTranscript.push({
            id: `${group.id}-prompt`,
            role: 'user',
            text: promptText,
            timestampLabel: group.startedAtLabel,
          });
        }

        for (const entry of group.entries) {
          const text = entry.text.trim();
          if (!text) continue;
          if (promptText && text === promptText) continue;
          if (noiseMarkers.some((marker) => text.startsWith(marker) || text.includes(marker))) continue;

          const role = runtimeTailRole(entry.label);
          if (role === 'assistant') {
            chatTranscript.push({
              id: entry.id,
              role: 'assistant',
              text,
              toolCalls: pendingToolCalls.length > 0 ? [...pendingToolCalls] : undefined,
              timestampLabel: entry.timestampLabel,
            });
            pendingToolCalls.length = 0;
          } else if (entry.kind === 'tool') {
            pendingToolCalls.push(toolCallFromEntry(entry.label || 'tool', entry.text));
          }
        }

        if (pendingToolCalls.length > 0) {
          chatTranscript.push({
            id: `${group.id}-tool-batch`,
            role: 'assistant',
            text: '',
            toolCalls: [...pendingToolCalls],
            timestampLabel: group.finishedAtLabel ?? group.startedAtLabel,
          });
        }
      }

      const payload: MobileHistoryResponse = { sessionKey, transcript: appendSteerEntries(sessionKey, chatTranscript) };
      return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
    }

    // Discovered Codex sessions — read JSONL tail from ~/.codex/sessions/
    if (sessionKey.startsWith('codex:')) {
      const tail = await getCodexRuntimeTail(sessionKey);
      const transcript: MobileTranscriptEntry[] = [];
      for (const entry of tail.entries ?? []) {
        if (entry.kind === 'event' && entry.label === 'Agent update') {
          transcript.push({ id: entry.id, role: 'assistant', text: entry.text, timestampLabel: entry.timestampLabel });
          continue;
        }
        if (entry.kind === 'tool') {
          transcript.push({
            id: entry.id,
            role: 'assistant',
            text: '',
            toolCalls: [toolCallFromEntry(entry.label || 'tool', entry.text)],
            timestampLabel: entry.timestampLabel,
          });
          continue;
        }
        if (entry.kind === 'message') {
          const role = runtimeTailRole(entry.label);
          if (role === 'system' || role === 'user') {
            const lowerText = entry.text.toLowerCase();
            if (lowerText.includes('<permissions') || lowerText.includes('collaboration_mode') || lowerText.includes('# agents.md') || lowerText.includes('sandbox_mode')) continue;
          }
          transcript.push({ id: entry.id, role, text: entry.text, timestampLabel: entry.timestampLabel });
          continue;
        }
        // Tool output: skip — the assistant summary covers what happened
        if (entry.kind === 'tool-output') {
          continue;
        }
      }
      // Deduplicate: remove entries with identical text (not just consecutive)
      const seen = new Set<string>();
      const deduped: MobileTranscriptEntry[] = [];
      for (const entry of transcript) {
        const toolKey = (entry.toolCalls ?? [])
          .map((tool) => `${tool.name}:${JSON.stringify(tool.args ?? {})}`)
          .join('|');
        const key = `${entry.role}:${entry.text.trim().slice(0, 200)}:${toolKey}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(entry);
      }
      const payload: MobileHistoryResponse = { sessionKey, transcript: appendSteerEntries(sessionKey, deduped) };
      return NextResponse.json(payload, {
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }

    // Claude Code sessions — read JSONL from ~/.claude/projects/
    if (sessionKey.startsWith('claude-code:')) {
      const ccRuntime = getRuntime('claude-code');
      if (ccRuntime?.readTranscript) {
        const entries = await ccRuntime.readTranscript(sessionKey, undefined, limit);
        const transcript: MobileTranscriptEntry[] = entries.map(entry => ({
          id: entry.id,
          role: entry.role === 'user' ? 'user' : entry.role === 'assistant' ? 'assistant' : 'system',
          text: entry.text,
          type: entry.type ?? 'message',
          timestamp: entry.timestamp.getTime(),
          timestampLabel: entry.timestamp
            ? entry.timestamp.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
            : '',
          toolCalls: entry.toolCalls && entry.toolCalls.length > 0
            ? entry.toolCalls.map((tool) => ({
                id: tool.id,
                name: tool.name,
                args: tool.args,
                preview: tool.preview,
                status: tool.status,
              }))
            : undefined,
          compaction: entry.compaction ? {
            timestamp: entry.compaction.timestamp.getTime(),
            tokensBefore: entry.compaction.tokensBefore,
            tokensAfter: entry.compaction.tokensAfter,
            trigger: entry.compaction.trigger,
            source: entry.compaction.source,
            summary: entry.compaction.summary,
          } : undefined,
        }));
        return NextResponse.json(
          { sessionKey, transcript: appendSteerEntries(sessionKey, transcript) } satisfies MobileHistoryResponse,
          { headers: { 'Cache-Control': 'no-store, max-age=0' } },
        );
      }
    }
    return NextResponse.json(
      {
        error: `Unsupported mobile session: ${sessionKey}`,
      },
      { status: 400 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to load mobile session history',
      },
      { status: 500 },
    );
  }
}
