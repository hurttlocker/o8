import { parseInlineMarkdownDataImages } from '@/lib/llm/inline-images';
import { toolsForAnthropic, toolsForOpenAI } from '@/lib/llm/tools';

export type Provider = 'anthropic' | 'openai' | 'google' | 'operator';

/** o8 Operator backing model for FOUNDERS/paid — Gemini Flash via
 *  GOOGLE_AI_API_KEY (tool-capable, fastest; not available to free users —
 *  Q ruling 2026-07-12: "nemo for free, gemini for founders"). Swapped to
 *  Gemini 3 (Q ruling 2026-07-13) after the model shootout Round 3: tied
 *  quality (2.00 across seeds on the production two-angle harness), ~15%
 *  faster p50, ~14% cheaper per suite than 2.5 despite higher list rates
 *  (fewer completion tokens). Live-verified on the Gemini API 2026-07-13. */
export const OPERATOR_GEMINI_MODEL = 'gemini-3-flash-preview';

/** Rollback for the founders rail — proven production record. The proxy tries
 *  this THROUGH GEMINI when the primary fails for any reason (preview IDs can
 *  be re-pointed or retired by Google) before touching the free chain. */
export const OPERATOR_GEMINI_ROLLBACK_MODEL = 'gemini-2.5-flash';

/** o8 Operator FREE chain — $0 OpenRouter models, ordered. Bake-off
 *  2026-07-12 (scratchpad bakeoff_results.json): nemotron passed tool-calling
 *  and scored 5/5 on the o8 explainer with zero invented features;
 *  gpt-oss-120b:free stays as the always-answers safety net (it fabricated
 *  product mechanics and threw a 42s outlier, so it lost the primary slot). */
export const OPERATOR_FREE_OPENROUTER_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'openai/gpt-oss-120b:free',
] as const;

export interface Message {
  role: string;
  content: string;
}

export type StreamEvent =
  | { type: 'content'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done' }
  | { type: 'tool_call_start'; toolName: string; toolId: string }
  | { type: 'tool_call_delta'; json: string }
  | { type: 'tool_call_end' }
  | { type: 'tool_call'; toolName: string; toolId: string; args: Record<string, unknown> }
  | { type: 'thinking'; text: string };

export interface ProviderBuildOptions {
  /** Whether to apply Anthropic prompt-cache breakpoint on the tools array (last tool). Default: true. */
  cacheBreakpoint?: boolean;
  /** Override extended-thinking budget_tokens for Anthropic explicit-effort requests (low/medium/high/max/xhigh). */
  thinkingBudgetTokens?: number;
}

export interface ProviderConfig {
  url: string;
  envKey: string;
  buildHeaders: (apiKey: string) => Record<string, string>;
  buildBody: (model: string, messages: Message[], options?: ProviderBuildOptions) => Record<string, unknown>;
  parseStream: (line: string) => StreamEvent | null;
}

// Justified exception: pricing and capability allowlists are external provider wire ids, not dispatch defaults.
const PRICING: Record<string, { input: number; output: number }> = {
  'gemini-3.1-pro-preview': { input: 1.25, output: 10 },
  'gemini-3-pro-preview': { input: 1.25, output: 10 },
  'gemini-3-flash-preview': { input: 0.50, output: 3.00 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.15, output: 0.60 },
  'gemini-2.5-flash-lite': { input: 0.04, output: 0.15 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 0.80, output: 4 },
  'gpt-5.5': { input: 2.50, output: 10 },
  'gpt-5.4': { input: 2.50, output: 10 },
  o3: { input: 10, output: 40 },
  'o4-mini': { input: 1.10, output: 4.40 },
};

/** Models that support thinking/reasoning output */
// Justified exception: capability allowlists must match external provider wire ids exactly.
const THINKING_MODELS = new Set([
  // Anthropic — opus and sonnet 4+ support extended thinking
  'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5',
  // OpenAI — o-series are reasoning models
  'o3', 'o4-mini', 'o3-mini',
  // Google — 2.5+ support thinking
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-pro-preview', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview',
]);

export const GOOGLE_PROVIDER_ENV_KEY = 'GOOGLE_AI_API_KEY';

export const PROVIDERS: Record<Exclude<Provider, 'google' | 'operator'>, ProviderConfig> = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    envKey: 'ANTHROPIC_API_KEY',
    buildHeaders: (apiKey) => ({
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    }),
    buildBody: (model, messages, options) => {
      const isThinkingModel = THINKING_MODELS.has(model);
      const maxTokens = isThinkingModel ? 16384 : 4096;
      const explicitBudget = options?.thinkingBudgetTokens;
      const budgetTokens = explicitBudget != null && Number.isFinite(explicitBudget) && explicitBudget > 0
        ? Math.floor(explicitBudget)
        : 10000;

      return {
        model,
        max_tokens: maxTokens,
        stream: true,
        ...(isThinkingModel ? { thinking: { type: 'enabled', budget_tokens: budgetTokens } } : {}),
        messages: messages
          .filter((message) => message.role !== 'system')
          .map((message) => {
            const parsedContent = parseInlineMarkdownDataImages(message.content);
            if (parsedContent.hasImages) {
              return {
                role: message.role,
                content: parsedContent.parts.map((part) => (
                  part.type === 'text'
                    ? { type: 'text', text: part.text }
                    : {
                        type: 'image',
                        source: {
                          type: 'base64',
                          media_type: part.image.mimeType,
                          data: part.image.base64Data,
                        },
                      }
                )),
              };
            }
            return { role: message.role, content: message.content };
          }),
        ...(messages.find((message) => message.role === 'system')
          ? { system: messages.find((message) => message.role === 'system')!.content }
          : {}),
        tools: toolsForAnthropic({ cacheBreakpoint: options?.cacheBreakpoint }),
      };
    },
    parseStream: (line) => {
      if (!line.startsWith('data: ')) return null;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return { type: 'done' };

      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          return { type: 'content', text: parsed.delta.text };
        }
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'thinking_delta') {
          return { type: 'thinking', text: parsed.delta.thinking ?? '' };
        }
        if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
          return {
            type: 'tool_call_start',
            toolName: parsed.content_block.name,
            toolId: parsed.content_block.id,
          };
        }
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta') {
          return { type: 'tool_call_delta', json: parsed.delta.partial_json };
        }
        if (parsed.type === 'content_block_stop') {
          return { type: 'tool_call_end' };
        }
        if (parsed.type === 'message_delta' && parsed.usage) {
          return {
            type: 'usage',
            inputTokens: parsed.usage.input_tokens ?? 0,
            outputTokens: parsed.usage.output_tokens ?? 0,
          };
        }
        if (parsed.type === 'message_start' && parsed.message?.usage) {
          return {
            type: 'usage',
            inputTokens: parsed.message.usage.input_tokens ?? 0,
            outputTokens: 0,
          };
        }
      } catch {
        return null;
      }

      return null;
    },
  },
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    envKey: 'OPENAI_API_KEY',
    buildHeaders: (apiKey) => ({
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    }),
    buildBody: (model, messages, _options) => {
      void _options;
      const isReasoningModel = THINKING_MODELS.has(model);

      return {
        model,
        stream: true,
        stream_options: { include_usage: true },
        ...(isReasoningModel ? { reasoning_effort: 'medium' } : {}),
        messages: messages.map((message) => {
          const parsedContent = parseInlineMarkdownDataImages(message.content);
          if (parsedContent.hasImages) {
            return {
              role: message.role,
              content: parsedContent.parts.map((part) => (
                part.type === 'text'
                  ? { type: 'text', text: part.text }
                  : { type: 'image_url', image_url: { url: part.image.dataUri } }
              )),
            };
          }
          return message;
        }),
        tools: toolsForOpenAI(),
      };
    },
    parseStream: (line) => {
      if (!line.startsWith('data: ')) return null;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return { type: 'done' };

      try {
        const parsed = JSON.parse(data);
        if (parsed.choices?.[0]?.delta?.content) {
          return { type: 'content', text: parsed.choices[0].delta.content };
        }
        if (parsed.choices?.[0]?.delta?.reasoning_content) {
          return { type: 'thinking', text: parsed.choices[0].delta.reasoning_content };
        }
        const toolCall = parsed.choices?.[0]?.delta?.tool_calls?.[0];
        if (toolCall?.function?.name) {
          return {
            type: 'tool_call_start',
            toolName: toolCall.function.name,
            toolId: toolCall.id || '',
          };
        }
        if (toolCall?.function?.arguments) {
          return { type: 'tool_call_delta', json: toolCall.function.arguments };
        }
        if (parsed.choices?.[0]?.finish_reason === 'tool_calls') {
          return { type: 'tool_call_end' };
        }
        if (parsed.usage) {
          return {
            type: 'usage',
            inputTokens: parsed.usage.prompt_tokens ?? 0,
            outputTokens: parsed.usage.completion_tokens ?? 0,
          };
        }
      } catch {
        return null;
      }

      return null;
    },
  },
};

export function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICING[model];
  if (!price) return 0;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

export function isSupportedProvider(provider: string): provider is Provider {
  return (
    provider === 'google'
    || provider === 'anthropic'
    || provider === 'openai'
    || provider === 'operator'
  );
}

export function resolveApiKey(provider: Provider): string | null {
  if (provider === 'google' || provider === 'operator') {
    return process.env[GOOGLE_PROVIDER_ENV_KEY] ?? null;
  }
  return process.env[PROVIDERS[provider].envKey] ?? null;
}
