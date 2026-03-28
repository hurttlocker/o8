import { NextRequest, NextResponse } from 'next/server';
import { getOwnedCodexRuntimeTail } from '@/lib/codex/owned';
import { getCodexRuntimeTail } from '@/lib/codex/sessions';
import { loadMobileLlmChatHistory } from '@/lib/llm/mobile-llm-chat';
import type { MobileHistoryResponse, MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';
import { getSessionTranscript } from '@/lib/openclaw/chat';
import '@/lib/runtimes'; // Ensure runtimes are registered
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

    if (sessionKey.startsWith('codex-owned:')) {
      const tail = await getOwnedCodexRuntimeTail(sessionKey);

      // Build a chat-style flat transcript (no groups/turns — just user bubbles and assistant bubbles)
      const chatTranscript: MobileTranscriptEntry[] = [];
      const groups = tail.groups ?? [];

      for (const group of groups) {
        const pendingToolCalls: MobileTranscriptToolCall[] = [];
        // User prompt → user bubble
        const promptText = group.prompt?.trim();
        if (promptText) {
          chatTranscript.push({
            id: `${group.id}-prompt`,
            role: 'user',
            text: promptText,
            timestampLabel: group.startedAtLabel,
          });
        }

        // Assistant entries from this turn → assistant bubbles
        for (const entry of group.entries) {
          const text = entry.text.trim();
          if (!text) continue;
          // Skip entries that just echo the prompt
          if (promptText && text === promptText) continue;
          // Skip meta noise (usage stats, launch/resume markers)
          if (text.startsWith('Usage •') || text.includes('Owned Codex session') || text.includes('Codex run launched')) continue;

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
            pendingToolCalls.push(toolCallFromEntry(entry.label || 'exec_command', entry.text));
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

      const payload: MobileHistoryResponse = {
        sessionKey,
        transcript: chatTranscript,
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
      const payload: MobileHistoryResponse = { sessionKey, transcript: deduped };
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
          timestampLabel: entry.timestamp
            ? entry.timestamp.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
            : '',
        }));
        return NextResponse.json(
          { sessionKey, transcript } satisfies MobileHistoryResponse,
          { headers: { 'Cache-Control': 'no-store, max-age=0' } },
        );
      }
    }

    // OpenClaw sessions — use gateway chat.history
    const fresh = request.nextUrl.searchParams.get('fresh') === '1';
    const transcript = await getSessionTranscript(sessionKey, limit, fresh);
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
