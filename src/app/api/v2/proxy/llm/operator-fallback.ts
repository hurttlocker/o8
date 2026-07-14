import type { AuthContext } from '@/lib/auth/middleware';
import { executeTool, TOOLS } from '@/lib/llm/tools';
import type { Message } from './provider-config';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_TIMEOUT_MS = 30_000;

// o8-model file editing on the free/OpenRouter rail — RESTRICTED to file ops.
// NO shell, NO github, NO dispatch: the o8 model must never push to GitHub
// (operator ruling 2026-07-14). executeTool sandboxes writes to scopedRepoRoot
// (validatePath blocks traversal, .env, .git).
const OPERATOR_FILE_TOOL_NAMES = ['read_file', 'write_file', 'edit_file'];
const MAX_TOOL_STEPS = 8;

interface StreamOptions {
  apiKey: string;
  messages: Message[];
  model: string;
  auth: AuthContext | null;
  /** When set, the stream opens with a 'fallback' banner event (paid plan whose
   *  Gemini quota died). Omit/null when this model IS the plan's primary — the
   *  free plan rides this path by design and must not see a degradation banner. */
  notice?: { originalModel: string; originalModelLabel: string; reason: string } | null;
  /** Attach the file-editing tool loop (Composer parity). Requires scopedRepoRoot. */
  enableTools?: boolean;
  /** Repo root the file tools are sandboxed to. Required when enableTools. */
  scopedRepoRoot?: string | null;
}

/**
 * o8 Operator OpenRouter path — streams an OpenAI-compatible response from an
 * OpenRouter model. This is the free plan's PRIMARY rail (nemotron, then
 * gpt-oss-120b — Q ruling + bake-off 2026-07-12) and the paid plan's fallback
 * when Gemini hits quota.
 *
 * Tools are disabled on this path: tool support here is future work (nemotron
 * passed tool-calling in the bake-off, but this stream doesn't carry a tools
 * array yet). Text-only chat.
 */
export async function streamOpenRouterFallback(options: StreamOptions): Promise<Response> {
  // Tool-capable path (free + founders-low Composer parity). Only when the caller
  // asked for tools AND a real repo resolved — never write to the app's own cwd.
  if (options.enableTools && options.scopedRepoRoot) {
    return streamOpenRouterWithTools({ ...options, scopedRepoRoot: options.scopedRepoRoot });
  }
  const { apiKey, messages, model, notice } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://o8.app',
        'X-Title': 'o8 Operator',
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'OpenRouter fallback request failed',
      }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => 'Unknown error');
    return new Response(
      JSON.stringify({
        error: `OpenRouter fallback error (${upstream.status}): ${text.slice(0, 500)}`,
      }),
      { status: upstream.status, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(streamController) {
      const enqueue = (payload: Record<string, unknown> | '[DONE]') => {
        const data = payload === '[DONE]' ? '[DONE]' : JSON.stringify(payload);
        streamController.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      // Degradation banner ONLY when this genuinely is a fallback (paid plan,
      // Gemini quota dead). The free plan's primary ride stays banner-free.
      if (notice) {
        enqueue({
          type: 'fallback',
          originalModel: notice.originalModel,
          originalModelLabel: notice.originalModelLabel,
          fallbackModel: model,
          fallbackModelLabel: 'OpenRouter free tier',
          reason: notice.reason,
        });
      }

      const reader = upstream.body?.getReader();
      if (!reader) {
        enqueue('[DONE]');
        streamController.close();
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
              const parsed = JSON.parse(payload);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta.length > 0) {
                enqueue({ type: 'content', text: delta });
              }
              if (parsed.usage) {
                enqueue({
                  type: 'usage',
                  inputTokens: parsed.usage.prompt_tokens ?? 0,
                  outputTokens: parsed.usage.completion_tokens ?? 0,
                });
              }
            } catch {
              // ignore malformed chunk
            }
          }
        }
      } finally {
        enqueue('[DONE]');
        streamController.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

type ORToolAcc = { id: string; name: string; args: string };

/**
 * Tool-capable OpenRouter operator loop (free + founders-low rail). The Gemini
 * rail's loop mirrored in OpenAI streaming format: attach the file-editing tools,
 * stream content, and on `tool_calls` execute each via `executeTool` (sandboxed
 * to scopedRepoRoot) then loop with the results threaded back. Emits the SAME
 * `tool_use`/`tool_result` frame shape as google-native-tools so the o8 backend
 * consumer + transcript render both rails identically. File edits only — the
 * model cannot push to GitHub.
 */
async function streamOpenRouterWithTools(
  options: StreamOptions & { scopedRepoRoot: string },
): Promise<Response> {
  const { apiKey, model, messages, notice, scopedRepoRoot } = options;

  const tools = TOOLS
    .filter((tool) => OPERATOR_FILE_TOOL_NAMES.includes(tool.name))
    .map((tool) => ({
      type: 'function' as const,
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));

  // OpenAI-format running conversation — carries assistant tool_calls + tool
  // results across steps. Loose typing because it mixes plain turns with
  // tool_call / tool-result turns.
  const convo: Record<string, unknown>[] = messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (payload: Record<string, unknown> | '[DONE]') => {
        const data = payload === '[DONE]' ? '[DONE]' : JSON.stringify(payload);
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      if (notice) {
        enqueue({
          type: 'fallback',
          originalModel: notice.originalModel,
          originalModelLabel: notice.originalModelLabel,
          fallbackModel: model,
          fallbackModelLabel: 'OpenRouter free tier',
          reason: notice.reason,
        });
      }

      try {
        for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
          const stepController = new AbortController();
          const timer = setTimeout(() => stepController.abort(), OPENROUTER_TIMEOUT_MS);
          let upstream: globalThis.Response;
          try {
            upstream = await fetch(OPENROUTER_URL, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://o8.app',
                'X-Title': 'o8 Operator',
              },
              body: JSON.stringify({ model, stream: true, messages: convo, tools, tool_choice: 'auto' }),
              signal: stepController.signal,
            });
          } finally {
            clearTimeout(timer);
          }

          if (!upstream.ok || !upstream.body) {
            const text = await upstream.text().catch(() => 'Unknown error');
            enqueue({ type: 'error', message: `OpenRouter error (${upstream.status}): ${text.slice(0, 300)}` });
            break;
          }

          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          const toolAcc = new Map<number, ORToolAcc>();

          readLoop:
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const payload = line.slice(6).trim();
              if (!payload) continue;
              if (payload === '[DONE]') break readLoop;
              let parsed;
              try { parsed = JSON.parse(payload); } catch { continue; }
              const delta = parsed.choices?.[0]?.delta;
              if (!delta) continue;
              if (typeof delta.content === 'string' && delta.content.length > 0) {
                enqueue({ type: 'content', text: delta.content });
              }
              if (Array.isArray(delta.tool_calls)) {
                for (const call of delta.tool_calls) {
                  const idx = typeof call.index === 'number' ? call.index : 0;
                  const cur = toolAcc.get(idx) ?? { id: '', name: '', args: '' };
                  if (call.id) cur.id = call.id;
                  if (call.function?.name) cur.name = call.function.name;
                  if (typeof call.function?.arguments === 'string') cur.args += call.function.arguments;
                  toolAcc.set(idx, cur);
                }
              }
            }
          }

          const calls = [...toolAcc.values()].filter((call) => call.name);
          if (calls.length === 0) {
            // No tool calls this step — the answer already streamed. Done.
            break;
          }

          convo.push({
            role: 'assistant',
            content: null,
            tool_calls: calls.map((call) => ({
              id: call.id || call.name,
              type: 'function',
              function: { name: call.name, arguments: call.args || '{}' },
            })),
          });

          for (const call of calls) {
            const toolCallId = call.id || call.name;
            enqueue({ type: 'tool_use', toolName: call.name, toolCallId, arguments: call.args, status: 'calling' });
            // Server-side allowlist ENFORCEMENT: executeTool can reach shell,
            // dispatch, and lane merge/create_pr. Advertising only file tools is
            // a soft guarantee — a model can still emit an undeclared call — so
            // reject anything outside the file-op allowlist before it runs
            // (2026-07-14 adversarial review round 2).
            if (!OPERATOR_FILE_TOOL_NAMES.includes(call.name)) {
              const denied = `Tool "${call.name}" is not available in this mode.`;
              enqueue({ type: 'tool_result', toolName: call.name, toolCallId, output: denied, status: 'error' });
              convo.push({ role: 'tool', tool_call_id: toolCallId, content: denied });
              continue;
            }
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(call.args || '{}'); } catch { /* malformed → the tool reports the error */ }
            const result = await executeTool(call.name, args, scopedRepoRoot);
            const isError = /^\s*error/i.test(result.content);
            enqueue({ type: 'tool_result', toolName: call.name, toolCallId, output: result.content, status: isError ? 'error' : 'done' });
            convo.push({ role: 'tool', tool_call_id: toolCallId, content: result.content });
          }

          if (step === MAX_TOOL_STEPS - 1) {
            enqueue({ type: 'content', text: '\n\n(Reached the tool-step limit — stopping here.)' });
          }
        }
      } catch (err) {
        enqueue({ type: 'error', message: err instanceof Error ? err.message : 'OpenRouter tool loop failed' });
      } finally {
        enqueue('[DONE]');
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
