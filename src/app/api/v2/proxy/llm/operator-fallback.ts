import type { AuthContext } from '@/lib/auth/middleware';
import type { Message } from './provider-config';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_TIMEOUT_MS = 30_000;

interface StreamOptions {
  apiKey: string;
  messages: Message[];
  model: string;
  auth: AuthContext | null;
  /** When set, the stream opens with a 'fallback' banner event (paid plan whose
   *  Gemini quota died). Omit/null when this model IS the plan's primary — the
   *  free plan rides this path by design and must not see a degradation banner. */
  notice?: { originalModel: string; originalModelLabel: string; reason: string } | null;
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
export async function streamOpenRouterFallback({
  apiKey,
  messages,
  model,
  auth: _auth,
  notice,
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
