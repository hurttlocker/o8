export const dynamic = 'force-dynamic';

/**
 * POST /api/v2/proxy/llm
 *
 * Token relay — proxies LLM API calls, meters tokens, enforces budgets.
 * This is the revenue surface for Cortex IDE.
 *
 * Streaming response via SSE (Server-Sent Events):
 *   data: {"type":"content","text":"Hello"}
 *   data: {"type":"usage","inputTokens":12,"outputTokens":45,"costUsd":0.0023}
 *   data: [DONE]
 *
 * Issue: https://github.com/hurttlocker/cortex-ide/issues/232
 */

import { NextRequest } from 'next/server';
import { withOptionalAuth, type AuthContext } from '@/lib/auth/middleware';
import { logUsage, getCurrentPeriodCost } from '@/lib/db/usage';

// ── Pricing (per 1M tokens) ──

const PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic
  'claude-opus-4-6':   { input: 15,   output: 75 },
  'claude-sonnet-4-5': { input: 3,    output: 15 },
  'claude-haiku-4-5':  { input: 0.80, output: 4 },
  // OpenAI
  'gpt-5.4':           { input: 2.50, output: 10 },
  'gpt-4o':            { input: 2.50, output: 10 },
  'o3':                { input: 10,   output: 40 },
  // Google
  'gemini-3-pro':      { input: 1.25, output: 10 },
  'gemini-2.5-flash':  { input: 0.15, output: 0.60 },
};

function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICING[model];
  if (!price) return 0;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

// ── Provider configs ──

type Provider = 'anthropic' | 'openai' | 'google';

interface ProviderConfig {
  url: string;
  envKey: string;
  buildHeaders: (apiKey: string) => Record<string, string>;
  buildBody: (model: string, messages: Message[]) => Record<string, unknown>;
  parseStream: (line: string) => { type: 'content'; text: string } | { type: 'usage'; inputTokens: number; outputTokens: number } | { type: 'done' } | null;
}

interface Message {
  role: string;
  content: string;
}

const PROVIDERS: Record<Provider, ProviderConfig> = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    envKey: 'ANTHROPIC_API_KEY',
    buildHeaders: (apiKey) => ({
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    }),
    buildBody: (model, messages) => ({
      model,
      max_tokens: 4096,
      stream: true,
      messages: messages.filter(m => m.role !== 'system'),
      ...(messages.find(m => m.role === 'system')
        ? { system: messages.find(m => m.role === 'system')!.content }
        : {}),
    }),
    parseStream: (line) => {
      if (!line.startsWith('data: ')) return null;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return { type: 'done' };
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          return { type: 'content', text: parsed.delta.text };
        }
        if (parsed.type === 'message_delta' && parsed.usage) {
          return { type: 'usage', inputTokens: parsed.usage.input_tokens ?? 0, outputTokens: parsed.usage.output_tokens ?? 0 };
        }
        if (parsed.type === 'message_start' && parsed.message?.usage) {
          return { type: 'usage', inputTokens: parsed.message.usage.input_tokens ?? 0, outputTokens: 0 };
        }
      } catch { /* ignore */ }
      return null;
    },
  },

  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    envKey: 'OPENAI_API_KEY',
    buildHeaders: (apiKey) => ({
      'Authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
    }),
    buildBody: (model, messages) => ({
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages,
    }),
    parseStream: (line) => {
      if (!line.startsWith('data: ')) return null;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return { type: 'done' };
      try {
        const parsed = JSON.parse(data);
        if (parsed.choices?.[0]?.delta?.content) {
          return { type: 'content', text: parsed.choices[0].delta.content };
        }
        if (parsed.usage) {
          return { type: 'usage', inputTokens: parsed.usage.prompt_tokens ?? 0, outputTokens: parsed.usage.completion_tokens ?? 0 };
        }
      } catch { /* ignore */ }
      return null;
    },
  },

  google: {
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    envKey: 'GOOGLE_AI_API_KEY',
    buildHeaders: () => ({
      'content-type': 'application/json',
    }),
    buildBody: (model, messages) => ({
      contents: messages
        .filter(m => m.role !== 'system')
        .map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
      ...(messages.find(m => m.role === 'system')
        ? { systemInstruction: { parts: [{ text: messages.find(m => m.role === 'system')!.content }] } }
        : {}),
    }),
    parseStream: (line) => {
      // Google streams JSON array chunks
      if (!line.trim() || line.trim() === '[' || line.trim() === ']' || line.trim() === ',') return null;
      try {
        const parsed = JSON.parse(line.replace(/^,/, ''));
        if (parsed.candidates?.[0]?.content?.parts?.[0]?.text) {
          return { type: 'content', text: parsed.candidates[0].content.parts[0].text };
        }
        if (parsed.usageMetadata) {
          return {
            type: 'usage',
            inputTokens: parsed.usageMetadata.promptTokenCount ?? 0,
            outputTokens: parsed.usageMetadata.candidatesTokenCount ?? 0,
          };
        }
      } catch { /* ignore */ }
      return null;
    },
  },
};

// ── Resolve API key ──

function resolveApiKey(provider: Provider): string | null {
  // For v1: use server-side env vars (BYOK later via api_keys table)
  const config = PROVIDERS[provider];
  return process.env[config.envKey] ?? null;
}

// ── Handler ──

export const POST = withOptionalAuth(async (request: NextRequest, auth: AuthContext | null) => {
  const body = await request.json().catch(() => null);
  if (!body?.model || !body?.provider || !Array.isArray(body?.messages)) {
    return new Response(
      JSON.stringify({ error: 'model, provider, and messages are required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const { model, provider, messages } = body as { model: string; provider: Provider; messages: Message[] };

  if (!PROVIDERS[provider]) {
    return new Response(
      JSON.stringify({ error: `Unsupported provider: ${provider}` }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Check budget for authenticated users on managed keys
  if (auth?.user && auth.user.plan !== 'free') {
    const spent = getCurrentPeriodCost(auth.user.id);
    const budget = auth.user.tokenBudgetUsd;
    if (budget != null && spent >= budget) {
      return new Response(
        JSON.stringify({ error: 'Monthly token budget exceeded. Upgrade your plan or add a BYOK key.' }),
        { status: 402, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  const apiKey = resolveApiKey(provider);
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: `No API key configured for ${provider}. Set ${PROVIDERS[provider].envKey} in your environment.` }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const config = PROVIDERS[provider];

  // Build the upstream request
  let url = config.url;
  if (provider === 'google') {
    url = `${config.url}/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
  }

  const headers = config.buildHeaders(apiKey);
  const upstreamBody = config.buildBody(model, messages);

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => 'Unknown error');
      return new Response(
        JSON.stringify({ error: `${provider} API error (${upstream.status}): ${errText.slice(0, 500)}` }),
        { status: upstream.status, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // Stream the response
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const reader = upstream.body?.getReader();
        if (!reader) {
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
              const parsed = config.parseStream(line);
              if (!parsed) continue;

              if (parsed.type === 'content') {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'content', text: parsed.text })}\n\n`));
              } else if (parsed.type === 'usage') {
                totalInputTokens += parsed.inputTokens;
                totalOutputTokens += parsed.outputTokens;
              } else if (parsed.type === 'done') {
                break;
              }
            }
          }

          // Send final usage event
          const costUsd = computeCost(model, totalInputTokens, totalOutputTokens);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: 'usage',
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            costUsd,
          })}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));

          // Log usage for authenticated users
          if (auth?.user && totalOutputTokens > 0) {
            try {
              logUsage({
                userId: auth.user.id,
                model,
                provider,
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
                costUsd,
                agentName: 'llm-chat',
                requestType: 'chat',
              });
            } catch (e) {
              console.error('[proxy/llm] Failed to log usage:', e);
            }
          }
        } catch (err) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: 'error',
            message: err instanceof Error ? err.message : 'Stream error',
          })}\n\n`));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Proxy request failed' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
});
