import { parseInlineMarkdownDataImages } from '@/lib/llm/inline-images';
import { toolsForAnthropic, toolsForOpenAI } from '@/lib/llm/tools';

export type Provider = 'anthropic' | 'openai' | 'google';

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

export interface ProviderConfig {
  url: string;
  envKey: string;
  buildHeaders: (apiKey: string) => Record<string, string>;
  buildBody: (model: string, messages: Message[]) => Record<string, unknown>;
  parseStream: (line: string) => StreamEvent | null;
}

const PRICING: Record<string, { input: number; output: number }> = {
  'gemini-3.1-pro-preview': { input: 1.25, output: 10 },
  'gemini-3-pro-preview': { input: 1.25, output: 10 },
  'gemini-3-flash-preview': { input: 0.15, output: 0.60 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.15, output: 0.60 },
  'gemini-2.5-flash-lite': { input: 0.04, output: 0.15 },
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 0.80, output: 4 },
  'gpt-5.4': { input: 2.50, output: 10 },
  'gpt-4o': { input: 2.50, output: 10 },
  o3: { input: 10, output: 40 },
};

export const GOOGLE_PROVIDER_ENV_KEY = 'GOOGLE_AI_API_KEY';

export const PROVIDERS: Record<Exclude<Provider, 'google'>, ProviderConfig> = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    envKey: 'ANTHROPIC_API_KEY',
    buildHeaders: (apiKey) => ({
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    }),
    buildBody: (model, messages) => {
      const isThinkingModel = /opus|sonnet-4/.test(model);
      const maxTokens = isThinkingModel ? 16384 : 4096;

      return {
        model,
        max_tokens: maxTokens,
        stream: true,
        ...(isThinkingModel ? { thinking: { type: 'enabled', budget_tokens: 10000 } } : {}),
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
        tools: toolsForAnthropic(),
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
    buildBody: (model, messages) => {
      const isReasoningModel = /^o[1-9]|^o3/.test(model);

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
  return provider === 'google' || provider === 'anthropic' || provider === 'openai';
}

export function resolveApiKey(provider: Provider): string | null {
  if (provider === 'google') {
    return process.env[GOOGLE_PROVIDER_ENV_KEY] ?? null;
  }
  return process.env[PROVIDERS[provider].envKey] ?? null;
}
