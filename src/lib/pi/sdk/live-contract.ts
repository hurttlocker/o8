import type { Model } from '@earendil-works/pi-ai';
import type { ManagedPiBillingContract } from './test-budget';

/**
 * Verified 2026-10-04. The hosted endpoint caps this model at 0.18 USD per
 * million prompt tokens and 0.72 USD per million completion tokens, with at
 * most 4096 output tokens per call; OpenRouter's published endpoint prices for
 * the model on the same date topped out at exactly those rates with no
 * per-request fee. Billable input tokens cannot exceed the serialized request
 * bytes; the extra 16 KiB covers provider-added prompt tokens.
 */
const MAX_REQUEST_BYTES = 65_536;

export const O8_MANAGED_FLASH_LITE_CONTRACT: ManagedPiBillingContract = {
  id: 'o8-managed-gemini-2-5-flash-lite-2026-10-04',
  modelId: 'google/gemini-2.5-flash-lite',
  endpoint: 'https://api.o8.run/v1/inference',
  evidence: 'Hosted endpoint price ceiling 0.18/0.72 USD per million prompt/completion tokens and 4096 output tokens for this model; OpenRouter published endpoints checked 2026-10-04: highest 0.18/0.72, no request fee',
  expiresAt: Date.UTC(2026, 9, 25),
  coverage: 'all-including-failed-requests',
  contextWindow: MAX_REQUEST_BYTES,
  maxRequestBytes: MAX_REQUEST_BYTES,
  maxBillableInputTokens: MAX_REQUEST_BYTES + 16_384,
  maxBillableOutputTokens: 4_096,
  inputMicroUsdPerMillion: 180_000,
  outputMicroUsdPerMillion: 720_000,
  fixedMicroUsdPerRequest: 0,
  maxCalls: 8,
};

/** Body fields the hosted endpoint accepts, plus stream_options and usage, which it strips first. */
export const MANAGED_INFERENCE_BODY_FIELDS: ReadonlySet<string> = new Set(['model', 'messages', 'max_tokens', 'stream',
  'temperature', 'top_p', 'tools', 'tool_choice', 'response_format', 'stop', 'stream_options', 'usage']);

/**
 * The managed model as Pi must describe it. The server accepts only model,
 * messages, max_tokens, stream, temperature, top_p, tools, tool_choice,
 * response_format and stop (it strips stream_options), so Pi must send
 * max_tokens, omit store, use the system role, and never add prompt cache
 * fields, even when PI_CACHE_RETENTION=long.
 */
export const O8_MANAGED_FLASH_LITE_MODEL: Model<'openai-completions'> = {
  id: O8_MANAGED_FLASH_LITE_CONTRACT.modelId,
  name: 'Gemini 2.5 Flash Lite (o8 managed)',
  api: 'openai-completions',
  provider: 'o8-managed',
  baseUrl: 'https://api.o8.run/v1',
  reasoning: false,
  input: ['text'],
  contextWindow: O8_MANAGED_FLASH_LITE_CONTRACT.contextWindow,
  maxTokens: O8_MANAGED_FLASH_LITE_CONTRACT.maxBillableOutputTokens,
  cost: { input: 0.18, output: 0.72, cacheRead: 0, cacheWrite: 0 },
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    supportsLongCacheRetention: false,
  },
};
