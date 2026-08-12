import { NextRequest, NextResponse } from 'next/server';
import { getCodexRuntimeTail, type RuntimeTailEntry } from '@/lib/codex/sessions';
import type { MobileTranscriptEntry, MobileTranscriptThinkingStep, MobileTranscriptToolCall } from '@/lib/mobile/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

function buildToolThinkingStep(tool: MobileTranscriptToolCall): MobileTranscriptThinkingStep {
  const args = tool.args ?? {};
  const label = tool.name === 'search_web'
    ? `Searching "${String(args.query ?? '')}"`
    : tool.name === 'read_file'
      ? `Reading ${String(args.path ?? '').split('/').pop() || 'file'}`
      : tool.name === 'search_code'
        ? `Searching code for "${String(args.query ?? '')}"`
        : tool.name === 'list_files'
          ? `Listing ${String(args.path ?? '.')}`
          : tool.name === 'create_github_issue'
            ? 'Creating GitHub issue'
            : tool.name === 'read_github_issue_or_pr'
              ? `Reading #${String(args.number ?? '')}`
              : tool.name === 'create_pull_request'
                ? 'Creating pull request'
                : `Running ${tool.name}`;
  const type = tool.name === 'search_web' || tool.name === 'search_code'
    ? 'search'
    : tool.name === 'read_file' || tool.name === 'list_files'
      ? 'reading'
      : 'tool';
  return {
    type,
    label,
    status: 'complete',
  };
}

function buildTranscript(entries: RuntimeTailEntry[]) {
  const transcript: MobileTranscriptEntry[] = [];
  let pendingThinking = '';
  let pendingToolCalls: MobileTranscriptToolCall[] = [];
  let pendingTokens: { input: number; output: number } | undefined;

  const shouldSkipUserText = (text: string) => {
    const lower = text.toLowerCase();
    return (
      lower.includes('# agents.md instructions')
      || lower.includes('<environment_context>')
      || lower.includes('<permissions instructions>')
      || lower.includes('<skills_instructions>')
      || lower.includes('<collaboration_mode>')
    );
  };

  const flushPendingTools = (timestampLabel?: string) => {
    if (pendingToolCalls.length === 0) return;
    transcript.push({
      id: `codex-tools-${transcript.length}`,
      role: 'assistant',
      text: '',
      timestampLabel,
      toolCalls: pendingToolCalls,
      thinkingSteps: pendingToolCalls.map(buildToolThinkingStep),
    });
    pendingToolCalls = [];
  };

  for (const entry of entries) {
    const text = entry.text.trim();
    const timestampLabel = entry.timestampLabel ?? '';

    if (entry.kind === 'tool') {
      pendingToolCalls.push({
        name: entry.label || 'tool',
        args: parseToolArgs(text),
        status: 'done',
      });
      continue;
    }

    if (entry.kind === 'tool-output') {
      if (pendingToolCalls.length > 0) {
        const last = pendingToolCalls[pendingToolCalls.length - 1];
        pendingToolCalls[pendingToolCalls.length - 1] = {
          ...last,
          preview: text || last.preview,
          status: 'done',
        };
      }
      continue;
    }

    if (entry.kind === 'event') {
      if (entry.label === 'Agent update') {
        continue;
      }
      if (entry.label === 'Reasoning') {
        pendingThinking = [pendingThinking, text || entry.thinking || ''].filter(Boolean).join('\n').trim();
        continue;
      }
      if (entry.tokens) {
        pendingTokens = entry.tokens;
        continue;
      }
      if (!text) continue;
      flushPendingTools(timestampLabel);
      transcript.push({
        id: entry.id,
        role: 'system',
        text,
        timestampLabel,
      });
      continue;
    }

    if (entry.kind === 'message') {
      if (entry.role === 'user') {
        if (shouldSkipUserText(text)) {
          pendingThinking = '';
          pendingTokens = undefined;
          continue;
        }
        flushPendingTools(timestampLabel);
        transcript.push({
          id: entry.id,
          role: 'user',
          text: text,
          timestampLabel,
        });
        pendingThinking = '';
        pendingTokens = undefined;
        continue;
      }
      const assistantText = text;
      if (!assistantText && pendingToolCalls.length === 0) continue;
      transcript.push({
        id: entry.id,
        role: 'assistant',
        text: assistantText,
        timestampLabel,
        toolCalls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
        tokens: entry.tokens ?? pendingTokens,
        thinking: entry.thinking || pendingThinking || undefined,
        thinkingSteps: pendingToolCalls.length > 0 ? pendingToolCalls.map(buildToolThinkingStep) : undefined,
      });
      pendingThinking = '';
      pendingToolCalls = [];
      pendingTokens = undefined;
    }
  }

  flushPendingTools();
  return transcript;
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
    const tail = await getCodexRuntimeTail(runtimeKey, limit);
    const transcript = buildTranscript(tail.entries ?? []).slice(-Math.max(Number.isFinite(limit) ? limit : 50, 1));

    return NextResponse.json(
      { transcript },
      {
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      },
    );
  } catch (err) {
    return NextResponse.json(
      {
        transcript: [],
        error: err instanceof Error ? err.message : 'unknown',
        pending: true,
      },
      {
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      },
    );
  }
}
