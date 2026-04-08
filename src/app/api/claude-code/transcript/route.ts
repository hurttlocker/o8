import { NextRequest, NextResponse } from 'next/server';
import { readdir, readFile, stat } from 'fs/promises';
import path from 'path';
import os from 'os';
import type { MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';
import { detectCompactionEvents } from '@/lib/runtimes/compaction-detector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

interface ClaudeMessage {
  type: string;
  subtype?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  total_cost_usd?: number;
  content?: string;
  compactMetadata?: {
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
    tokensAfter?: number;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: ContentBlock[];
}

function usageFromUnknown(input: unknown): { input: number; output: number } | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const usage = input as { input_tokens?: unknown; output_tokens?: unknown };
  const next = {
    input: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
    output: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
  };
  return next.input > 0 || next.output > 0 ? next : undefined;
}

function coerceToolArgs(input: unknown): Record<string, unknown> | undefined {
  if (!input) return undefined;
  if (typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return { input };
}

function extractTranscriptPayload(content: string | ContentBlock[] | undefined): {
  text: string;
  toolCalls: MobileTranscriptToolCall[];
} {
  if (!content) return { text: '', toolCalls: [] };
  if (typeof content === 'string') return { text: content, toolCalls: [] };

  const textParts: string[] = [];
  const toolCalls: MobileTranscriptToolCall[] = [];

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      textParts.push(block.text);
      continue;
    }

    if (block.type === 'tool_use' && block.name) {
      toolCalls.push({
        name: block.name,
        args: coerceToolArgs(block.input),
        status: 'done',
      });
      continue;
    }

    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      const inner = extractTranscriptPayload(block.content);
      if (inner.text) {
        textParts.push(inner.text);
      }
    }
  }

  return {
    text: textParts.join('\n').trim(),
    toolCalls,
  };
}

/**
 * GET /api/claude-code/transcript?sessionKey=claude-code:live-PID&limit=50
 *
 * Reads the Claude Code session JSONL and returns transcript entries
 * compatible with the AgentPanelChat transcript format.
 */
export async function GET(req: NextRequest) {
  const sessionKey = req.nextUrl.searchParams.get('sessionKey') ?? '';
  const limit = parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10);

  if (!sessionKey.startsWith('claude-code:')) {
    return NextResponse.json({ transcript: [] });
  }

  try {
    const projectDirs = await readdir(CLAUDE_PROJECTS_DIR).catch(() => []);
    const sessionId = sessionKey.replace('claude-code:', '');
    let targetFile: string | null = null;

    // Try to find the specific session JSONL by UUID first.
    if (sessionId && !sessionId.startsWith('live-')) {
      for (const dir of projectDirs) {
        const candidate = path.join(CLAUDE_PROJECTS_DIR, dir, `${sessionId}.jsonl`);
        try {
          await stat(candidate);
          targetFile = candidate;
          break;
        } catch { /* not in this dir */ }
      }
    }

    // Fallback: most recently modified JSONL (for live-PID sessions or unknown UUIDs).
    if (!targetFile) {
      let bestMtime = 0;
      for (const dir of projectDirs) {
        const dirPath = path.join(CLAUDE_PROJECTS_DIR, dir);
        try {
          const files = await readdir(dirPath);
          for (const file of files) {
            if (!file.endsWith('.jsonl')) continue;
            const filePath = path.join(dirPath, file);
            const fileStat = await stat(filePath);
            if (fileStat.mtimeMs > bestMtime) {
              bestMtime = fileStat.mtimeMs;
              targetFile = filePath;
            }
          }
        } catch { /* skip */ }
      }
    }

    if (!targetFile) {
      return NextResponse.json({ transcript: [] });
    }

    // Read and parse the JSONL
    const raw = await readFile(targetFile, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const parsedEntries: ClaudeMessage[] = [];

    for (const line of lines) {
      try {
        parsedEntries.push(JSON.parse(line) as ClaudeMessage);
      } catch { /* skip malformed lines */ }
    }

    const compactionEvents = detectCompactionEvents(parsedEntries);

    const skippedEntryIds = new Set(
      compactionEvents.flatMap((event) => [
        event.boundaryEntryId,
        event.summaryEntryId,
      ]).filter((id): id is string => Boolean(id)),
    );

    const transcript: MobileTranscriptEntry[] = compactionEvents.map((event) => ({
      id: event.id,
      role: 'system',
      text: 'Context compaction event',
      type: 'compaction',
      timestamp: event.timestamp.getTime(),
      timestampLabel: event.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      compaction: {
        timestamp: event.timestamp.getTime(),
        tokensBefore: event.tokensBefore,
        tokensAfter: event.tokensAfter,
        trigger: event.trigger,
        source: event.source,
        summary: event.summary,
      },
    }));

    for (const entry of parsedEntries) {
      if (entry.uuid && skippedEntryIds.has(entry.uuid)) continue;
      if (entry.isCompactSummary) continue;

      if (entry.type === 'result') {
        const latestAssistant = [...transcript].reverse().find((candidate) => candidate.role === 'assistant');
        if (latestAssistant) {
          latestAssistant.costUsd = typeof entry.total_cost_usd === 'number' ? entry.total_cost_usd : latestAssistant.costUsd;
          latestAssistant.tokens = usageFromUnknown(entry.usage) ?? latestAssistant.tokens;
        }
        continue;
      }

      if (entry.type !== 'user' && entry.type !== 'assistant') continue;
      if (entry.isMeta) continue;

      const role = entry.type === 'user' ? 'user' : 'assistant';
      const payload = extractTranscriptPayload(entry.message?.content);
      const text = payload.text;

      if ((!text.trim() && payload.toolCalls.length === 0) || text.startsWith('<command-message>')) continue;

      const ts = entry.timestamp ? new Date(entry.timestamp) : new Date();
      const timestampLabel = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      transcript.push({
        id: entry.uuid ?? `cc-${transcript.length}`,
        role,
        text,
        type: 'message',
        timestamp: ts.getTime(),
        timestampLabel,
        model: entry.message?.model,
        tokens: usageFromUnknown(entry.message?.usage),
        toolCalls: payload.toolCalls.length > 0 ? payload.toolCalls : undefined,
      });
    }

    transcript.sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));

    // Return most recent entries up to limit
    const sliced = transcript.slice(-limit);

    return NextResponse.json({ transcript: sliced }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
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
