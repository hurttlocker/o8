export const dynamic = 'force-dynamic';

import { spawn } from 'node:child_process';
import { NextResponse } from 'next/server';

/**
 * POST /api/v2/proxy/cli
 *
 * Routes chat messages through an installed CLI runtime (Claude Code, Codex, Gemini CLI)
 * instead of a provider API. Spawns the CLI as a subprocess, pipes the prompt,
 * and streams the output back as SSE events matching our existing stream format.
 */

type CliRuntime = 'claude-code' | 'codex' | 'gemini';

type CliEffort = 'low' | 'medium' | 'high' | 'max';

interface CliRequestBody {
  runtime: CliRuntime;
  model: string;       // e.g. 'cli:claude-code:opus' → extract 'opus' or 'haiku'
  messages: { role: string; content: string }[];
  effort?: CliEffort;
}

/** Map CLI model id suffix to the --model flag value */
const CLAUDE_MODEL_MAP: Record<string, string> = {
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
};

const CODEX_MODEL_MAP: Record<string, string> = {
  'gpt-5.4': 'gpt-5.4',
  'o4-mini': 'o4-mini',
};

const GEMINI_MODEL_MAP: Record<string, string> = {
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-2.5-flash': 'gemini-2.5-flash',
};

const VALID_EFFORTS = new Set<string>(['low', 'medium', 'high', 'max']);

function extractModelKey(cliModelId: string): string {
  // cli:claude-code:opus → opus
  const parts = cliModelId.split(':');
  return parts[parts.length - 1];
}

function buildPrompt(messages: { role: string; content: string }[]): string {
  // Take the last user message as the prompt
  const userMessages = messages.filter((m) => m.role === 'user');
  const lastUser = userMessages[userMessages.length - 1];
  if (!lastUser) return '';

  // Include recent context (last few assistant messages for continuity)
  const recent = messages.slice(-6);
  const contextParts: string[] = [];
  for (const m of recent) {
    if (m === lastUser) break;
    if (m.role === 'assistant') {
      contextParts.push(`Previous assistant response: ${m.content.slice(0, 500)}`);
    }
  }

  if (contextParts.length > 0) {
    return `${contextParts.join('\n')}\n\nUser: ${lastUser.content}`;
  }
  return lastUser.content;
}

function sse(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as CliRequestBody | null;
    if (!body?.runtime || !body?.model || !Array.isArray(body?.messages)) {
      return NextResponse.json({ error: 'runtime, model, and messages are required' }, { status: 400 });
    }

    const { runtime, model, messages, effort } = body;
    const modelKey = extractModelKey(model);
    const prompt = buildPrompt(messages);
    if (!prompt) {
      return NextResponse.json({ error: 'No user message found' }, { status: 400 });
    }

    let cmd: string;
    let args: string[];

    switch (runtime) {
      case 'claude-code': {
        const cliModel = CLAUDE_MODEL_MAP[modelKey] ?? 'sonnet';
        cmd = 'claude';
        args = ['--print', '--output-format', 'stream-json', '--verbose', '--model', cliModel];
        if (effort && VALID_EFFORTS.has(effort)) {
          args.push('--effort', effort);
        }
        args.push(prompt);
        break;
      }
      case 'codex': {
        const cliModel = CODEX_MODEL_MAP[modelKey] ?? 'gpt-5.4';
        cmd = 'codex';
        args = ['exec', '--json', '-c', `model="${cliModel}"`, '--', prompt];
        break;
      }
      case 'gemini': {
        const cliModel = GEMINI_MODEL_MAP[modelKey] ?? 'gemini-2.5-flash';
        cmd = 'gemini';
        args = ['--prompt', prompt, '--output-format', 'stream-json', '--model', cliModel];
        break;
      }
      default:
        return NextResponse.json({ error: `Unsupported runtime: ${runtime}` }, { status: 400 });
    }

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const child = spawn(cmd, args, {
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        });

        let buffer = '';

        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              const events = normalizeCliEvent(runtime, parsed);
              for (const event of events) {
                controller.enqueue(encoder.encode(sse(event)));
              }
            } catch {
              // Not JSON, skip
            }
          }
        });

        child.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf-8').trim();
          if (text && !text.includes('DeprecationWarning')) {
            console.error(`[cli-proxy] ${runtime} stderr:`, text);
          }
        });

        child.on('close', () => {
          // Flush remaining buffer
          if (buffer.trim()) {
            try {
              const parsed = JSON.parse(buffer);
              const events = normalizeCliEvent(runtime, parsed);
              for (const event of events) {
                controller.enqueue(encoder.encode(sse(event)));
              }
            } catch { /* ignore */ }
          }
          controller.enqueue(encoder.encode(sse({ type: 'done' })));
          controller.close();
        });

        child.on('error', (err) => {
          controller.enqueue(encoder.encode(sse({ type: 'error', message: err.message })));
          controller.close();
        });
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (err) {
    console.error('[cli-proxy] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'CLI proxy failed' },
      { status: 500 },
    );
  }
}

// ── Normalize CLI events to our SSE format ──

type SseEvent = Record<string, unknown>;

/* eslint-disable @typescript-eslint/no-explicit-any */
function normalizeCliEvent(runtime: CliRuntime, raw: any): SseEvent[] {
  switch (runtime) {
    case 'claude-code':
      return normalizeClaude(raw);
    case 'codex':
      return normalizeCodex(raw);
    case 'gemini':
      return normalizeGemini(raw);
    default:
      return [];
  }
}

function normalizeClaude(raw: any): SseEvent[] {
  const events: SseEvent[] = [];

  if (raw.type === 'assistant' && raw.message?.content) {
    for (const block of raw.message.content) {
      if (block.type === 'thinking' && block.thinking) {
        events.push({ type: 'thinking', text: block.thinking });
      }
      if (block.type === 'text' && block.text) {
        events.push({ type: 'content', text: block.text });
      }
      if (block.type === 'tool_use') {
        events.push({ type: 'tool_call', toolName: block.name, toolId: block.id, args: block.input ?? {} });
      }
    }
    if (raw.message.usage) {
      events.push({
        type: 'usage',
        inputTokens: raw.message.usage.input_tokens ?? 0,
        outputTokens: raw.message.usage.output_tokens ?? 0,
      });
    }
  }

  if (raw.type === 'result') {
    if (raw.usage) {
      events.push({
        type: 'usage',
        inputTokens: raw.usage.input_tokens ?? 0,
        outputTokens: raw.usage.output_tokens ?? 0,
      });
    }
  }

  return events;
}

function normalizeCodex(raw: any): SseEvent[] {
  const events: SseEvent[] = [];

  if (raw.type === 'item.completed' && raw.item?.text) {
    events.push({ type: 'content', text: raw.item.text });
  }

  if (raw.type === 'turn.completed' && raw.usage) {
    events.push({
      type: 'usage',
      inputTokens: raw.usage.input_tokens ?? 0,
      outputTokens: raw.usage.output_tokens ?? 0,
    });
  }

  return events;
}

function normalizeGemini(raw: any): SseEvent[] {
  const events: SseEvent[] = [];

  if (raw.type === 'message' && raw.role === 'assistant' && raw.content) {
    events.push({ type: 'content', text: raw.content });
  }

  if (raw.type === 'result' && raw.stats) {
    events.push({
      type: 'usage',
      inputTokens: raw.stats.input_tokens ?? raw.stats.input ?? 0,
      outputTokens: raw.stats.output_tokens ?? 0,
    });
  }

  return events;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
