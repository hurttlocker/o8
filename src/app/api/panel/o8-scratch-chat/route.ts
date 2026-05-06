import { NextRequest } from 'next/server';
import { resolveOpenRouterKey } from '@/lib/cortex/qa/llm/byok-keys';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODELS = [
  'poolside/laguna-m.1:free',
  'openai/gpt-oss-120b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
];
const MAX_MESSAGE_CHARS = 6_000;
const MAX_CONTEXT_CHARS = 28_000;
const MAX_HISTORY_MESSAGES = 10;

type ScratchRole = 'user' | 'assistant';

interface ScratchMessage {
  role: ScratchRole;
  content: string;
}

interface ScratchContext {
  repoPath?: string;
  filePath?: string;
  surface?: 'file' | 'diff';
  selection?: string;
  content?: string;
}

function jsonError(message: string, status: number) {
  return new Response(
    JSON.stringify({ error: message }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function clampText(value: unknown, max: number) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n\n[truncated]`;
}

function parseHistory(value: unknown): ScratchMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-MAX_HISTORY_MESSAGES)
    .map((item) => {
      const record = asRecord(item);
      if (!record) return null;
      const role = record.role === 'user' || record.role === 'assistant' ? record.role : null;
      const content = clampText(record.content, MAX_MESSAGE_CHARS);
      return role && content ? { role, content } satisfies ScratchMessage : null;
    })
    .filter((item): item is ScratchMessage => Boolean(item));
}

function parseContext(value: unknown): ScratchContext {
  const record = asRecord(value);
  if (!record) return {};
  const surface = record.surface === 'diff' || record.surface === 'file' ? record.surface : undefined;
  return {
    repoPath: clampText(record.repoPath, 700),
    filePath: clampText(record.filePath, 700),
    surface,
    selection: clampText(record.selection, 8_000),
    content: clampText(record.content, MAX_CONTEXT_CHARS),
  };
}

function contextBlock(context: ScratchContext) {
  const lines = [
    context.repoPath ? `Repo: ${context.repoPath}` : null,
    context.filePath ? `File: ${context.filePath}` : null,
    context.surface ? `Surface: ${context.surface}` : null,
    context.selection ? `Selected text:\n${context.selection}` : null,
    context.content ? `Visible context:\n${context.content}` : null,
  ].filter(Boolean);

  return lines.length > 0
    ? `Current O8 workspace context:\n\n${lines.join('\n\n')}`
    : 'Current O8 workspace context: no file or diff content was available.';
}

function encodeEvent(payload: Record<string, unknown>) {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function scratchModels() {
  const raw = process.env.O8_SCRATCH_OPENROUTER_MODELS?.trim()
    || process.env.O8_SCRATCH_OPENROUTER_MODEL?.trim()
    || '';
  if (!raw) return DEFAULT_MODELS;
  const configured = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_MODELS;
}

async function openRouterRequest({
  apiKey,
  messages,
  model,
  signal,
}: {
  apiKey: string;
  messages: Array<{ role: string; content: string }>;
  model: string;
  signal: AbortSignal;
}) {
  return fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://o8.app',
      'X-Title': 'o8 Scratch Chat',
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages,
    }),
    signal,
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const apiKey = await resolveOpenRouterKey();
  if (!apiKey) {
    return jsonError('OPENROUTER_API_KEY is not configured.', 503);
  }

  const rawBody = await request.json().catch(() => null);
  const body = asRecord(rawBody);
  if (!body) {
    return jsonError('Invalid request body.', 400);
  }

  const message = clampText(body.message, MAX_MESSAGE_CHARS);
  if (!message) {
    return jsonError('Message is required.', 400);
  }

  const history = parseHistory(body.history);
  const context = parseContext(body.context);

  const messages = [
    {
      role: 'system',
      content: [
        'You are o8, a read-only scratch assistant inside the O8 file and diff panel.',
        'Help the operator understand the selected file, selected text, or diff.',
        'Do not claim that you edited, saved, applied, dispatched, or ran anything.',
        'If the operator asks for a code change, explain the proposed change and suggest handing a summary to the orchestrator. You may show draft snippets, but label them as drafts.',
        'Keep answers concise and practical.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: contextBlock(context),
    },
    ...history,
    {
      role: 'user',
      content: message,
    },
  ];

  let upstream: Response | null = null;
  let selectedModel = '';
  const failures: string[] = [];
  for (const model of scratchModels()) {
    try {
      const response = await openRouterRequest({
        apiKey,
        messages,
        model,
        signal: request.signal,
      });
      if (response.ok) {
        upstream = response;
        selectedModel = model;
        break;
      }
      const text = await response.text().catch(() => 'Unknown upstream error.');
      failures.push(`${model}: HTTP ${response.status} ${text.slice(0, 180)}`);
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') {
        return jsonError('Scratch chat request was cancelled.', 499);
      }
      failures.push(`${model}: ${error instanceof Error ? error.message : 'OpenRouter request failed.'}`);
    }
  }

  if (!upstream) {
    return jsonError(`OpenRouter fallback chain failed. ${failures.join(' | ')}`, 502);
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encodeEvent({ type: 'model', model: selectedModel }));
      const reader = upstream.body?.getReader();
      if (!reader) {
        controller.enqueue(encodeEvent({ type: 'error', message: 'OpenRouter did not return a stream.' }));
        controller.enqueue(encodeEvent({ type: 'done' }));
        controller.close();
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payload) as Record<string, unknown>;
              const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
              const first = asRecord(choices[0]);
              const delta = asRecord(first?.delta);
              const text = typeof delta?.content === 'string' ? delta.content : '';
              if (text) {
                controller.enqueue(encodeEvent({ type: 'content', text }));
              }
            } catch {
              // Ignore malformed upstream chunks.
            }
          }
        }
        controller.enqueue(encodeEvent({ type: 'done' }));
      } catch (error) {
        controller.enqueue(encodeEvent({
          type: 'error',
          message: error instanceof Error ? error.message : 'Scratch chat stream failed.',
        }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
