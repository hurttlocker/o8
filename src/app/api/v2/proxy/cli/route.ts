export const dynamic = 'force-dynamic';

import { spawn } from 'node:child_process';
import { NextResponse } from 'next/server';

import { formatMissingCliError } from '@/lib/runtimes/shared/cli-unavailable';
import { CliNotFoundError, resolveCli } from '@/lib/runtimes/shared/cli-resolver';

/**
 * POST /api/v2/proxy/cli
 *
 * Routes chat messages through an installed CLI runtime (Claude Code, Codex, Gemini CLI)
 * instead of a provider API. Spawns the CLI as a subprocess, pipes the prompt,
 * and streams the output back as SSE events matching our existing stream format.
 */

type CliRuntime = 'claude-code' | 'codex' | 'gemini' | 'opencode';

type CliEffort = 'low' | 'medium' | 'high' | 'max';

interface CliRequestBody {
  runtime: CliRuntime;
  model: string;       // e.g. 'cli:claude-code:opus' → extract 'opus' or 'haiku'
  messages: { role: string; content: string }[];
  effort?: CliEffort;
  repoPath?: string;
}

/** Map CLI model id suffix to the --model flag value */
const CLAUDE_MODEL_MAP: Record<string, string> = {
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
};

const CODEX_MODEL_MAP: Record<string, string> = {
  'gpt-5.6-sol': 'gpt-5.6-sol',
  'gpt-5.6-terra': 'gpt-5.6-terra',
  'gpt-5.6-luna': 'gpt-5.6-luna',
  'gpt-5.5': 'gpt-5.5',
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

    const { runtime, model, messages, effort, repoPath } = body;
    const modelKey = extractModelKey(model);
    const prompt = buildPrompt(messages);
    if (!prompt) {
      return NextResponse.json({ error: 'No user message found' }, { status: 400 });
    }

    // Resolve repo path for cwd — validate against registry to prevent directory traversal
    let cwd = process.cwd();
    if (repoPath?.trim()) {
      const { resolveRepoPathFromRegistry } = await import('@/lib/repos/repo-path-registry');
      const resolved = await resolveRepoPathFromRegistry(repoPath.trim());
      if (!resolved.ok) {
        return NextResponse.json({
          error: `[repo] ${resolved.message}`,
          code: 'repo_unavailable',
        }, { status: resolved.status });
      }
      cwd = resolved.repoRoot;
    }

    let cmd: string;
    let args: string[];
    let cliSpec: {
      runtimeId: string;
      binaryName: string;
      humanLabel: string;
      envOverride: string;
    };

    switch (runtime) {
      case 'claude-code': {
        // Removed June 2026 — Anthropic's pricing change billed every
        // `claude --print` against the user's Agent SDK credit pool. We don't
        // want operators to accidentally route chat through the metered pool.
        // Operators who want Claude reach it directly via Claude Code TUI or
        // Claude Desktop, which stays on the unlimited interactive pool.
        return NextResponse.json({
          error: 'claude-code CLI is disabled. Use the LLM proxy with your ANTHROPIC_API_KEY, or talk to Claude in Claude Code / Desktop directly.',
        }, { status: 410 });
      }
      case 'codex': {
        const cliModel = CODEX_MODEL_MAP[modelKey] ?? 'gpt-5.6-sol';
        cmd = 'codex';
        cliSpec = {
          runtimeId: 'codex',
          binaryName: cmd,
          humanLabel: 'Codex',
          envOverride: 'O8_CODEX_BIN',
        };
        args = ['exec', '--json', '-c', `model="${cliModel}"`, '--', prompt];
        break;
      }
      case 'gemini': {
        const cliModel = GEMINI_MODEL_MAP[modelKey] ?? 'gemini-2.5-flash';
        cmd = 'gemini';
        cliSpec = {
          runtimeId: 'gemini',
          binaryName: cmd,
          humanLabel: 'Gemini CLI',
          envOverride: 'O8_GEMINI_BIN',
        };
        args = ['--prompt', prompt, '--output-format', 'stream-json', '--model', cliModel];
        break;
      }
      case 'opencode': {
        // opencode's auto-selected default in non-TTY context is sometimes a stale model
        // (e.g. google/gemini-3-pro-preview) that fails with 404 — pass an explicit -m so
        // the spawn is deterministic. opencode/gpt-5-nano is one of opencode's own free
        // hosted models and works without user auth. Issue #512 tracks per-provider rows.
        cmd = 'opencode';
        cliSpec = {
          runtimeId: 'opencode',
          binaryName: cmd,
          humanLabel: 'OpenCode',
          envOverride: 'O8_OPENCODE_BIN',
        };
        args = ['run', '--format', 'json', '-m', 'opencode/gpt-5-nano', prompt];
        break;
      }
      default:
        return NextResponse.json({ error: `Unsupported runtime: ${runtime}` }, { status: 400 });
    }

    try {
      cmd = (await resolveCli(cliSpec)).path;
    } catch (error) {
      if (!(error instanceof CliNotFoundError)) throw error;
      return NextResponse.json({
        error: formatMissingCliError({
          ...cliSpec,
          triedPaths: error.triedPaths,
        }),
        code: 'runtime_not_installed',
        runtime,
      }, { status: 503 });
    }

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const child = spawn(cmd, args, {
          cwd,
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
    case 'opencode':
      return normalizeOpenCode(raw);
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

function normalizeOpenCode(raw: any): SseEvent[] {
  // opencode --format json emits envelope events of the shape:
  //   { type: 'step_start' | 'text' | 'tool' | 'step_finish', part: {...} }
  // where `part.type` describes the inner block. Verified against opencode 1.4.3.
  const events: SseEvent[] = [];
  const part = raw.part;

  if (raw.type === 'text' && part?.type === 'text' && typeof part.text === 'string') {
    events.push({ type: 'content', text: part.text });
  }

  // Tool invocation — opencode emits the tool call inside a part with type='tool'
  if (raw.type === 'tool' && part?.type === 'tool' && part.name) {
    events.push({
      type: 'tool_call',
      toolName: part.name,
      toolId: part.id ?? '',
      args: part.input ?? part.arguments ?? {},
    });
  }

  // Reasoning / thinking blocks
  if (raw.type === 'reasoning' && part?.type === 'reasoning' && typeof part.text === 'string') {
    events.push({ type: 'thinking', text: part.text });
  }

  // Usage on step finish — { tokens: { input, output, reasoning, cache, total }, cost }
  if (raw.type === 'step_finish' && part?.tokens) {
    events.push({
      type: 'usage',
      inputTokens: part.tokens.input ?? 0,
      outputTokens: part.tokens.output ?? 0,
      ...(typeof part.cost === 'number' ? { costUsd: part.cost } : {}),
    });
  }

  return events;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
