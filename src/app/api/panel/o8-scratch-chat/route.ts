import { NextRequest } from 'next/server';
import { resolveOpenRouterRoute, type InferenceRoute } from '@/lib/cortex/qa/llm/inference-route';
import { TOOLS, executeTool, toolsForOpenAI } from '@/lib/llm/tools';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const DEFAULT_MODELS = [
  'poolside/laguna-m.1:free',
  'openai/gpt-oss-120b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
];
const MAX_MESSAGE_CHARS = 6_000;
const MAX_CONTEXT_CHARS = 28_000;
const MAX_HISTORY_MESSAGES = 10;
const MAX_TOOL_ROUNDS = 12;

type ScratchRole = 'user' | 'assistant' | 'tool' | 'system';

interface ScratchToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ScratchMessage {
  role: ScratchRole;
  content: string | null;
  tool_calls?: ScratchToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ScratchContext {
  repoPath?: string;
  filePath?: string;
  surface?: 'file' | 'diff';
  selection?: string;
  content?: string;
}

const VALID_TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

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
  const result: ScratchMessage[] = [];
  for (const item of value.slice(-MAX_HISTORY_MESSAGES)) {
    const record = asRecord(item);
    if (!record) continue;
    const role = record.role === 'user' || record.role === 'assistant' ? record.role : null;
    const content = clampText(record.content, MAX_MESSAGE_CHARS);
    if (role && content) {
      result.push({ role, content });
    }
  }
  return result;
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

function scratchModels(override?: string | null) {
  const overrideTrimmed = typeof override === 'string' ? override.trim() : '';
  if (overrideTrimmed) {
    // Single-model override pinned by the operator (chat-mode model
    // picker). No fallback — if this model is unavailable, the request
    // fails so the operator gets a clear signal instead of silently
    // routing to a different model.
    return [overrideTrimmed];
  }
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

interface OpenRouterRequestOptions {
  route: InferenceRoute;
  messages: ScratchMessage[];
  model: string;
  signal: AbortSignal;
  withTools: boolean;
}

async function openRouterRequest({ route, messages, model, signal, withTools }: OpenRouterRequestOptions) {
  const body: Record<string, unknown> = {
    model,
    stream: true,
    messages,
  };
  if (withTools) {
    body.tools = toolsForOpenAI();
    body.tool_choice = 'auto';
  }
  return fetch(route.url, {
    method: 'POST',
    headers: route.headers,
    body: JSON.stringify(body),
    signal,
  });
}

function parseToolEnable(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true' || value === '1';
  return false;
}

interface StreamRoundResult {
  selectedModel: string;
  finishReason: string | null;
  assistantText: string;
  toolCalls: ScratchToolCall[];
}

function emitChunkContent(
  chunk: Record<string, unknown>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  partial: { text: string; toolCalls: Map<number, ScratchToolCall> },
): string | null {
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  const first = asRecord(choices[0]);
  if (!first) return null;
  const delta = asRecord(first.delta);
  if (delta) {
    const text = typeof delta.content === 'string' ? delta.content : '';
    if (text) {
      partial.text += text;
      controller.enqueue(encodeEvent({ type: 'content', text }));
    }
    const deltaToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const item of deltaToolCalls) {
      const record = asRecord(item);
      if (!record) continue;
      const index = typeof record.index === 'number' ? record.index : 0;
      const existing = partial.toolCalls.get(index) ?? {
        id: '',
        type: 'function' as const,
        function: { name: '', arguments: '' },
      };
      if (typeof record.id === 'string' && record.id) existing.id = record.id;
      const fn = asRecord(record.function);
      if (fn) {
        if (typeof fn.name === 'string' && fn.name) existing.function.name = fn.name;
        if (typeof fn.arguments === 'string') existing.function.arguments += fn.arguments;
      }
      partial.toolCalls.set(index, existing);
    }
  }
  return typeof first.finish_reason === 'string' ? first.finish_reason : null;
}

async function streamRound({
  route,
  messages,
  signal,
  controller,
  withTools,
  modelOverride,
}: {
  route: InferenceRoute;
  messages: ScratchMessage[];
  signal: AbortSignal;
  controller: ReadableStreamDefaultController<Uint8Array>;
  withTools: boolean;
  modelOverride?: string | null;
}): Promise<StreamRoundResult | { error: string }> {
  const failures: string[] = [];
  for (const model of route.model ? [route.model] : scratchModels(modelOverride)) {
    try {
      const response = await openRouterRequest({ route, messages, model, signal, withTools });
      if (!response.ok) {
        const text = await response.text().catch(() => 'Unknown upstream error.');
        failures.push(`${model}: HTTP ${response.status} ${text.slice(0, 180)}`);
        continue;
      }
      controller.enqueue(encodeEvent({ type: 'model', model }));

      const reader = response.body?.getReader();
      if (!reader) {
        failures.push(`${model}: empty stream body`);
        continue;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      const partial = { text: '', toolCalls: new Map<number, ScratchToolCall>() };
      let finishReason: string | null = null;

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
            const reason = emitChunkContent(parsed, controller, partial);
            if (reason) finishReason = reason;
          } catch {
            // Ignore malformed upstream chunks.
          }
        }
      }

      const orderedToolCalls = Array.from(partial.toolCalls.entries())
        .sort(([a], [b]) => a - b)
        .map(([, call]) => call)
        .filter((call) => call.function.name && VALID_TOOL_NAMES.has(call.function.name));

      return {
        selectedModel: model,
        finishReason,
        assistantText: partial.text,
        toolCalls: orderedToolCalls,
      };
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') {
        return { error: 'aborted' };
      }
      failures.push(`${model}: ${error instanceof Error ? error.message : 'OpenRouter request failed.'}`);
    }
  }
  return { error: `OpenRouter fallback chain failed. ${failures.join(' | ')}` };
}

export async function POST(request: NextRequest): Promise<Response> {
  const route = await resolveOpenRouterRoute();
  if (!route) {
    return jsonError('No inference route — set an OpenRouter key or apply a plan.', 503);
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
  const enableTools = parseToolEnable(body.enableTools ?? body.tools);
  const modelOverride = typeof body.modelOverride === 'string' && body.modelOverride.trim()
    ? body.modelOverride.trim()
    : null;
  const repoRoot = context.repoPath || process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();

  const conversation: ScratchMessage[] = [
    {
      role: 'user',
      content: enableTools
        ? [
            'You are o8, an in-app assistant that helps the operator use o8 itself.',
            'You can call tools to inspect repos, dispatch coding work to agents, search the web, and run safe shell commands. Use tools when they would actually help; otherwise just answer.',
            'When dispatching coding work, prefer dispatch_codex_task over write_file/edit_file unless the change is a single small file. Be specific about repo path, branch, and success criteria.',
            'Keep replies concise and practical.',
          ].join('\n')
        : [
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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const result = await streamRound({
            route,
            messages: conversation,
            signal: request.signal,
            controller,
            withTools: enableTools,
            modelOverride,
          });
          if ('error' in result) {
            if (result.error === 'aborted') {
              controller.enqueue(encodeEvent({ type: 'error', message: 'Scratch chat request was cancelled.' }));
            } else {
              controller.enqueue(encodeEvent({ type: 'error', message: result.error }));
            }
            controller.enqueue(encodeEvent({ type: 'done' }));
            return;
          }

          if (!enableTools || result.toolCalls.length === 0 || result.finishReason !== 'tool_calls') {
            controller.enqueue(encodeEvent({ type: 'done' }));
            return;
          }

          // Append assistant turn (with tool_calls) and execute each tool.
          conversation.push({
            role: 'assistant',
            content: result.assistantText || null,
            tool_calls: result.toolCalls,
          });

          for (const call of result.toolCalls) {
            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = call.function.arguments ? JSON.parse(call.function.arguments) as Record<string, unknown> : {};
            } catch {
              parsedArgs = {};
            }
            controller.enqueue(encodeEvent({
              type: 'tool_call',
              id: call.id,
              name: call.function.name,
              args: parsedArgs,
            }));
            try {
              const toolResult = await executeTool(call.function.name, parsedArgs, repoRoot);
              controller.enqueue(encodeEvent({
                type: 'tool_result',
                id: call.id,
                name: call.function.name,
                content: toolResult.content,
                sources: toolResult.sources ?? [],
              }));
              conversation.push({
                role: 'tool',
                tool_call_id: call.id,
                name: call.function.name,
                content: toolResult.content.slice(0, 12_000),
              });
            } catch (toolError) {
              const message = toolError instanceof Error ? toolError.message : 'Tool execution failed.';
              controller.enqueue(encodeEvent({
                type: 'tool_result',
                id: call.id,
                name: call.function.name,
                content: `Error: ${message}`,
                sources: [],
              }));
              conversation.push({
                role: 'tool',
                tool_call_id: call.id,
                name: call.function.name,
                content: `Error: ${message}`,
              });
            }
          }
        }

        // Tool budget exhausted — force one final no-tools turn so the model
        // summarizes whatever it discovered instead of leaving the user with
        // a raw error. Append a nudge as a system message.
        conversation.push({
          role: 'system',
          content: `You have used all ${MAX_TOOL_ROUNDS} tool-call rounds. Stop calling tools and answer the user now using only what you already gathered. Be concise — summarize, don't list everything.`,
        });
        const finalResult = await streamRound({
          route,
          messages: conversation,
          signal: request.signal,
          controller,
          withTools: false,
          modelOverride,
        });
        if ('error' in finalResult) {
          controller.enqueue(encodeEvent({
            type: 'error',
            message: finalResult.error === 'aborted'
              ? 'Scratch chat request was cancelled.'
              : finalResult.error,
          }));
        }
        controller.enqueue(encodeEvent({ type: 'done' }));
      } catch (error) {
        try {
          controller.enqueue(encodeEvent({
            type: 'error',
            message: error instanceof Error ? error.message : 'Scratch chat stream failed.',
          }));
        } catch {
          // Controller may already be closed if the client aborted.
        }
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed (e.g. abort, double-close on early return).
        }
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
