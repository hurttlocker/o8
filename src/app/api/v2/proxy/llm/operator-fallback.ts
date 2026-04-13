import type { AuthContext } from '@/lib/auth/middleware';
import type { Message } from './provider-config';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_TIMEOUT_MS = 30_000;

interface StreamOptions {
  apiKey: string;
  messages: Message[];
  model: string;
  auth: AuthContext | null;
}

/**
 * o8 Operator fallback path — streams an OpenAI-compatible response from OpenRouter
 * using a free model. This runs when the primary Gemini call hits quota.
 *
 * Tools are disabled in the fallback path: free models often don't honor tool calls
 * reliably. The user gets text-only chat until Gemini quota resets.
 */
export async function streamOpenRouterFallback({
  apiKey,
  messages,
  model,
  auth: _auth,
}: StreamOptions): Promise<Response> {
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

      // Notify the client that the operator is in fallback mode.
      enqueue({
        type: 'fallback',
        originalModel: 'gemini-2.5-flash',
        fallbackModel: model,
        reason: 'Gemini quota exhausted — using OpenRouter free tier',
      });

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
