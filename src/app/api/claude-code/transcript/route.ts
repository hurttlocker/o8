import { NextRequest, NextResponse } from 'next/server';
import { readdir, readFile, stat } from 'fs/promises';
import path from 'path';
import os from 'os';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

interface ClaudeMessage {
  type: 'user' | 'assistant' | string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    model?: string;
  };
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: ContentBlock[];
}

function extractText(content: string | ContentBlock[] | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'tool_use' && block.name) {
      parts.push(`🔧 ${block.name}`);
    } else if (block.type === 'tool_result') {
      // Recurse into tool result content
      if (Array.isArray(block.content)) {
        const inner = extractText(block.content);
        if (inner) parts.push(inner);
      }
    }
  }
  return parts.join('\n');
}

/**
 * GET /api/claude-code/transcript?sessionKey=claude-code:live-PID&limit=50
 *
 * Reads the Claude Code session JSONL and returns transcript entries
 * compatible with the DesktopChat transcript format.
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

    const transcript: {
      id: string;
      role: string;
      text: string;
      timestampLabel: string;
    }[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as ClaudeMessage;

        // Skip non-message entries
        if (entry.type !== 'user' && entry.type !== 'assistant') continue;

        // Skip meta/command messages
        if (entry.isMeta) continue;

        const role = entry.type === 'user' ? 'user' : 'assistant';
        const text = extractText(entry.message?.content);

        // Skip empty or command-only messages
        if (!text.trim() || text.startsWith('<command-message>')) continue;

        const ts = entry.timestamp ? new Date(entry.timestamp) : new Date();
        const timestampLabel = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        transcript.push({
          id: entry.uuid ?? `cc-${transcript.length}`,
          role,
          text,
          timestampLabel,
        });
      } catch { /* skip malformed lines */ }
    }

    // Return most recent entries up to limit
    const sliced = transcript.slice(-limit);

    return NextResponse.json({ transcript: sliced }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (err) {
    return NextResponse.json(
      { transcript: [], error: err instanceof Error ? err.message : 'unknown' },
      { status: 500 },
    );
  }
}
