export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/mobile/genui/stream — OpenAI-compatible chat-completions facade
 * for the mobile generative-UI spike (AppLess/OpenUI pattern, 2026-07-16).
 *
 * The mobile app's `@openuidev/react-lang` stream layer speaks the vanilla
 * OpenAI `/chat/completions` SSE dialect; none of our internal LLM surfaces
 * do. This route is the adapter: it accepts `{ model?, messages, stream? }`
 * and emits `chat.completion.chunk` SSE frames (or a full `chat.completion`
 * JSON body when `stream: false`).
 *
 * The server owns model routing — no keys or authoritative model selector live
 * on the device. The phone only presents the ws-token (this route is gated by
 * the default-deny middleware like the rest of /api/mobile):
 *
 *   - Text requests use the warm Claude REPL pool (subscription-billed, same
 *     pool as the Brain's CLI tiers — never `-p`/`--print`, see #1124).
 *   - Image requests return an explicit pre-stream fallback signal so the
 *     phone can preserve the image and use managed Ask.
 */

import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { askClaudeWarm } from '@/lib/claude-code/warm-repl-pool';
import { resolveOpenRouterRoute } from '@/lib/cortex/qa/llm/inference-route';
import { MODEL_IDS, RAW_MODEL_IDS } from '@/lib/models';

const execFileAsync = promisify(execFile);

const CLI_TIMEOUT_MS = 120_000;
// Spend guardrail for the hosted tier: a generated screen is a few hundred
// tokens of openui-lang; 8K is generous headroom, not an open tap.
const HOSTED_MAX_TOKENS = 8_192;

interface ChatMessage {
  role?: unknown;
  content?: unknown;
}

interface GenUiRequestBody {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  max_tokens?: unknown;
}

function jsonError(message: string, status: number, headers?: HeadersInit) {
  return NextResponse.json(
    { error: { message, type: 'invalid_request_error' } },
    { status, headers },
  );
}

/** OpenAI content can be a string or an array of typed parts — flatten to text. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''))
      .join('');
  }
  return '';
}

function messagesContainImages(messages: ChatMessage[]): boolean {
  return messages.some((message) =>
    Array.isArray(message.content)
    && message.content.some((part) =>
      Boolean(part)
      && typeof part === 'object'
      && (part as { type?: unknown }).type === 'image_url'),
  );
}

/**
 * The warm REPL takes one user frame, so the OpenAI message array is
 * flattened: system blocks first, then the conversation transcript. Good
 * enough for the spike — screen continuity in the OpenUI pattern is carried
 * in the messages themselves, not in server-side session state.
 */
function flattenMessages(messages: ChatMessage[]): string {
  const system: string[] = [];
  const turns: string[] = [];
  for (const msg of messages) {
    const text = contentToText(msg.content).trim();
    if (!text) continue;
    if (msg.role === 'system') system.push(text);
    else if (msg.role === 'assistant') turns.push(`Assistant: ${text}`);
    else turns.push(`User: ${text}`);
  }
  return [...system, turns.join('\n\n')].filter(Boolean).join('\n\n');
}

// ── Claude binary resolution (mirrors haiku-adapter / sonnet-adapter) ────────

let cachedClaudeBin: string | null | undefined;

async function resolveClaudeBin(): Promise<string | null> {
  if (cachedClaudeBin !== undefined) return cachedClaudeBin;
  for (const envKey of ['O8_CLAUDE_CODE_BIN', 'CLAUDE_BIN']) {
    const val = process.env[envKey];
    if (val) {
      cachedClaudeBin = val;
      return cachedClaudeBin;
    }
  }
  try {
    const { stdout } = await execFileAsync('which', ['claude'], { timeout: 3_000 });
    const found = stdout.trim();
    if (found) {
      cachedClaudeBin = found;
      return cachedClaudeBin;
    }
  } catch { /* fall through to login shell */ }
  // Finder-launched Tauri apps miss nvm/volta PATH entries — probe a login shell.
  try {
    const { stdout } = await execFileAsync('/bin/zsh', ['-lic', 'command -v claude'], { timeout: 8_000 });
    const found = stdout.trim().split('\n').pop()?.trim() || '';
    cachedClaudeBin = found || null;
  } catch {
    cachedClaudeBin = null;
  }
  return cachedClaudeBin;
}

// ── Model routing ─────────────────────────────────────────────────────────────

function resolveCliModel(model: string): string | null {
  if (model === '' || model === 'haiku' || model === 'default') return MODEL_IDS.claudeHaikuQaDefault;
  if (model === 'sonnet') return RAW_MODEL_IDS.anthropicClaudeSonnet5;
  if (model.startsWith('claude-')) return model;
  return null;
}

// ── SSE plumbing ─────────────────────────────────────────────────────────────

function chunkFrame(id: string, created: number, model: string, delta: Record<string, string>, finish: string | null): string {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
}

function completionBody(id: string, created: number, model: string, text: string) {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  };
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: GenUiRequestBody;
  try {
    body = await req.json() as GenUiRequestBody;
  } catch {
    return jsonError('Invalid JSON body.', 400);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonError('messages array is required.', 400);
  }
  const messages = body.messages as ChatMessage[];
  if (messagesContainImages(messages)) {
    return jsonError(
      'Image requests use managed Ask.',
      409,
      { 'X-O8-Ask-Fallback': 'managed' },
    );
  }
  // Compatibility fields are accepted, but the paired desktop chooses its own
  // subscription-backed model instead of trusting a phone-supplied model id.
  const requestedModel = '';
  const wantStream = body.stream !== false;
  const id = `genui-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);

  const cliModel = resolveCliModel(requestedModel);
  if (cliModel) {
    const binary = await resolveClaudeBin();
    if (!binary) {
      return jsonError('claude CLI not found — the subscription tier needs Claude Code installed on the desktop.', 503);
    }
    const prompt = flattenMessages(messages);
    if (!prompt) return jsonError('messages contained no text content.', 400);

    if (!wantStream) {
      try {
        const text = await askClaudeWarm(prompt, { binary, model: cliModel, timeoutMs: CLI_TIMEOUT_MS });
        return NextResponse.json(completionBody(id, created, cliModel, text));
      } catch (error) {
        console.error('[genui] cli completion failed:', error instanceof Error ? error.message : 'unknown');
        return jsonError('Generation failed on the CLI tier.', 502);
      }
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(chunkFrame(id, created, cliModel, { role: 'assistant', content: '' }, null)));
        askClaudeWarm(prompt, {
          binary,
          model: cliModel,
          timeoutMs: CLI_TIMEOUT_MS,
          onDelta: (text) => {
            try {
              controller.enqueue(encoder.encode(chunkFrame(id, created, cliModel, { content: text }, null)));
            } catch { /* client went away mid-stream */ }
          },
        })
          .then(() => {
            controller.enqueue(encoder.encode(chunkFrame(id, created, cliModel, {}, 'stop')));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          })
          .catch((error) => {
            console.error('[genui] cli stream failed:', error instanceof Error ? error.message : 'unknown');
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: 'Generation failed on the CLI tier.' } })}\n\n`));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            } catch { /* already closed */ }
          });
      },
    });
    return new Response(stream, { headers: sseHeaders() });
  }

  // Hosted tier — managed plan proxy (founder fast path) → local → BYO OpenRouter.
  const route = await resolveOpenRouterRoute();
  if (!route) {
    return jsonError('No hosted inference available — add an OpenRouter key or an active plan, or use the default CLI tier.', 503);
  }
  const requestedMax = typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens) ? body.max_tokens : HOSTED_MAX_TOKENS;
  const upstreamBody = {
    model: route.model ?? requestedModel,
    messages: messages.map((m) => ({ role: m.role, content: contentToText(m.content) })),
    stream: wantStream,
    max_tokens: Math.min(Math.max(1, requestedMax), HOSTED_MAX_TOKENS),
  };

  let upstream: Response;
  try {
    upstream = await fetch(route.url, {
      method: 'POST',
      headers: route.headers,
      body: JSON.stringify(upstreamBody),
    });
  } catch (error) {
    console.error('[genui] hosted fetch failed:', error instanceof Error ? error.message : 'unknown');
    return jsonError('Hosted inference request failed.', 502);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    console.error(`[genui] hosted upstream ${upstream.status} via ${route.via}: ${detail.slice(0, 300)}`);
    return jsonError(`Hosted inference failed upstream (${upstream.status}).`, 502);
  }

  const upstreamType = upstream.headers.get('content-type') || '';
  // Streaming upstream (OpenRouter/local SSE is already OpenAI-shaped) — pipe through.
  if (wantStream && upstreamType.includes('text/event-stream') && upstream.body) {
    return new Response(upstream.body, { headers: sseHeaders() });
  }

  // Non-SSE upstream (e.g. the managed proxy answering JSON): normalize. When
  // the caller asked to stream, synthesize a minimal chunk sequence so the
  // OpenUI client's SSE parser still works.
  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    return jsonError('Hosted inference returned an unreadable response.', 502);
  }
  const text = extractCompletionText(payload);
  if (text === null) {
    return jsonError('Hosted inference response had no completion content.', 502);
  }
  const model = upstreamBody.model || 'hosted';
  if (!wantStream) {
    return NextResponse.json(completionBody(id, created, model, text));
  }
  const encoder = new TextEncoder();
  const synthesized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(chunkFrame(id, created, model, { role: 'assistant', content: text }, null)));
      controller.enqueue(encoder.encode(chunkFrame(id, created, model, {}, 'stop')));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(synthesized, { headers: sseHeaders() });
}

/** Pull assistant text out of an OpenAI-shaped (or proxy-shaped) completion body. */
function extractCompletionText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as { choices?: unknown; text?: unknown; content?: unknown };
  if (Array.isArray(obj.choices) && obj.choices[0] && typeof obj.choices[0] === 'object') {
    const choice = obj.choices[0] as { message?: { content?: unknown }; text?: unknown };
    const fromMessage = contentToText(choice.message?.content);
    if (fromMessage) return fromMessage;
    if (typeof choice.text === 'string' && choice.text) return choice.text;
  }
  if (typeof obj.text === 'string' && obj.text) return obj.text;
  const fromContent = contentToText(obj.content);
  return fromContent || null;
}
