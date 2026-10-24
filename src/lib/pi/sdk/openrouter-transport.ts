/**
 * Pi on the user's OpenRouter connection (#3584).
 *
 * A sibling of the managed transport: the host resolves the key on every call
 * and owns the URL, headers, method and redirect policy, and Pi's OpenAI
 * adapter contributes only the request body. The key never enters the SDK
 * worker process. Before each call the run's spend ceiling must cover the
 * call's worst case, so a run cannot pass its ceiling by more than nothing;
 * after the call the reservation settles to the cost OpenRouter reported.
 */

import type { AssistantMessageEvent, Context, Model } from '@earendil-works/pi-ai/compat';
import type { PiModelTransport } from './transport';
import { applyPromptCache, cachePrefixContext, promptCacheEnabled, promptCachePolicy } from './prompt-cache';

export { isOpenRouterPiModelChoice, OPENROUTER_PI_MODEL_PREFIX } from './openrouter-model-choice';
export const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_PI_MAX_OUTPUT_TOKENS = 4096;

/** USD per million tokens, from the OpenRouter catalogue. */
export interface OpenRouterPiPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface OpenRouterPiReceipt {
  /** OpenRouter's generation id for the call, when the stream reported one. */
  generationId: string | null;
  /** The exact OpenRouter model id the call was pinned to. */
  model: string;
  status: 'completed' | 'failed' | 'stopped' | 'refused';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Cost OpenRouter reported for the call, or null when it reported none. Never a guess. */
  costUsd: number | null;
  /** The worst-case cost admitted before the call. */
  reservedUsd: number;
  startedAt: string;
  finishedAt: string;
  purpose?: 'turn' | 'prewarm' | 'keepalive';
  cacheWriteTokens?: number;
  cachedTokenRatio?: number | null;
  timeToFirstTokenMs?: number | null;
}

/**
 * The run's spend ceiling. A call is admitted only while every reservation
 * plus every settled cost stays within the limit. A call that reports no cost
 * keeps its full reservation counted.
 */
export class OpenRouterSpendCeiling {
  private committed = 0;
  constructor(readonly limitUsd: number) {
    if (!Number.isFinite(limitUsd) || limitUsd <= 0) throw new Error('OpenRouter spend ceiling must be a positive amount');
  }

  get spentUsd(): number { return this.committed; }

  /** Starts a new run against the same limit. */
  reset(): void { this.committed = 0; }

  reserve(amountUsd: number): boolean {
    if (!Number.isFinite(amountUsd) || amountUsd < 0 || this.committed + amountUsd > this.limitUsd) return false;
    this.committed += amountUsd;
    return true;
  }

  settle(reservedUsd: number, actualUsd: number | null): void {
    if (actualUsd === null || !Number.isFinite(actualUsd) || actualUsd < 0) return;
    this.committed = Math.max(0, this.committed - reservedUsd + actualUsd);
  }
}

/** The OpenRouter model as Pi's OpenAI adapter must describe it. */
export function openRouterPiModel(modelId: string, pricing: OpenRouterPiPricing, contextWindow = 128_000): Model<'openai-completions'> {
  return {
    id: modelId,
    name: `${modelId} (OpenRouter)`,
    api: 'openai-completions',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    reasoning: false,
    input: ['text'],
    contextWindow,
    maxTokens: OPENROUTER_PI_MAX_OUTPUT_TOKENS,
    cost: { input: pricing.inputPerMillion, output: pricing.outputPerMillion, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
      supportsLongCacheRetention: false,
    },
  };
}

/** Worst-case cost of one call. Input tokens are bounded by the request size: no token is shorter than one byte. */
export function worstCaseCallUsd(requestBytes: number, maxOutputTokens: number, pricing: OpenRouterPiPricing): number {
  return (requestBytes * pricing.inputPerMillion + maxOutputTokens * pricing.outputPerMillion) / 1_000_000;
}

export interface OpenRouterPiTransportOptions {
  model: Model<'openai-completions'>;
  pricing: OpenRouterPiPricing;
  ceiling: OpenRouterSpendCeiling;
  /** Resolves the key in the host on every call; null refuses the call. */
  resolveKey: () => Promise<string | null>;
  onReceipt?: (receipt: OpenRouterPiReceipt) => void;
  fetch?: typeof fetch;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

/** A 402 means the OpenRouter account or key has no credit left; o8 spent nothing on the refused call. */
export const OPENROUTER_NO_CREDIT_TEXT = 'OpenRouter has no credit left for this key or account (402). Add credit on OpenRouter, then try again.';
/** Failure text the Pi session may show. Anything else becomes a generic failure. */
export const OPENROUTER_PI_FAILURE_TEXT = /^OpenRouter (?:is not connected|rejected the request \(\d{3}\)|request failed|spend ceiling reached for this run|has no credit left for this key or account \(402\)\. Add credit on OpenRouter, then try again\.)$/;

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function withoutProviderDiagnostics(event: AssistantMessageEvent): AssistantMessageEvent {
  if (!('partial' in event)) return event;
  const { errorMessage: _providerText, ...partial } = event.partial;
  return { ...event, partial };
}

export function createOpenRouterPiTransport(options: OpenRouterPiTransportOptions): PiModelTransport {
  const maxOutputTokens = options.maxOutputTokens ?? OPENROUTER_PI_MAX_OUTPUT_TOKENS;
  const policy = promptCachePolicy(options.model.id);
  const preparedSessions = new WeakSet<AbortSignal>();
  const run = async function* (context: Context, signal: AbortSignal, purpose: OpenRouterPiReceipt['purpose'] = 'turn'): AsyncGenerator<AssistantMessageEvent> {
    signal.throwIfAborted();
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    let timeToFirstTokenMs: number | null = null;
    const outputLimit = purpose === 'turn' ? maxOutputTokens : 1;
    const timeout = AbortSignal.timeout(purpose === 'turn' ? options.timeoutMs ?? 120_000 : 10_000);
    const requestSignal = AbortSignal.any([signal, timeout]);
    let failure: string | null = null;
    let reservedUsd = 0;
    let admitted = false;
    let generationId: string | null = null;
    let usage: Record<string, unknown> | null = null;
    let status: OpenRouterPiReceipt['status'] = 'failed';

    const guardedFetch: typeof fetch = async (_input, init) => {
      requestSignal.throwIfAborted();
      const key = (await options.resolveKey())?.trim();
      requestSignal.throwIfAborted();
      if (purpose !== 'turn' && !promptCacheEnabled()) throw new Error('Cache warming disabled');
      if (!key) { failure = 'OpenRouter is not connected'; throw new Error(failure); }
      let body = typeof init?.body === 'string' ? init.body : '';
      if (policy && promptCacheEnabled()) body = applyPromptCache(body, policy);
      if (purpose !== 'turn') {
        const warm = JSON.parse(body);
        warm.tool_choice = 'none';
        body = JSON.stringify(warm);
      }
      // Extended cache writes have a higher input price. Reserve that price
      // even for a hit: a provider eviction can turn any hit into a write.
      reservedUsd = worstCaseCallUsd(Buffer.byteLength(body, 'utf8'), outputLimit,
        { ...options.pricing, inputPerMillion: options.pricing.inputPerMillion * (policy && promptCacheEnabled() ? policy.writeMultiplier : 1) });
      if (!options.ceiling.reserve(reservedUsd)) {
        reservedUsd = 0;
        status = 'refused';
        failure = 'OpenRouter spend ceiling reached for this run';
        throw new Error(failure);
      }
      admitted = true;
      // Pi's OpenAI adapter builds the request; only its body is reused. The
      // route, credential, method and redirect policy stay with the host.
      const response = await (options.fetch ?? fetch)(OPENROUTER_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'X-Title': 'o8 Pi' },
        body,
        redirect: 'error',
        signal: requestSignal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        failure = response.status === 402
          ? OPENROUTER_NO_CREDIT_TEXT
          : `OpenRouter rejected the request (${response.status})`;
        throw new Error(failure);
      }
      return response;
    };

    try {
      // Preserve the SDK's ESM export boundary in the CommonJS dev host too.
      const { streamSimple } = await import('@earendil-works/pi-ai/compat');
      requestSignal.throwIfAborted();
      const stream = streamSimple(options.model, context, {
        apiKey: 'host-transport-only', fetch: guardedFetch, signal: requestSignal,
        onProviderStreamEvent: (chunk) => {
          if (!chunk || typeof chunk !== 'object') return;
          const record = chunk as Record<string, unknown>;
          if (typeof record.id === 'string' && record.id) generationId = record.id;
          if (record.usage && typeof record.usage === 'object') usage = record.usage as Record<string, unknown>;
        },
        maxRetries: 0, maxTokens: outputLimit, transport: 'sse',
      });
      for await (const event of stream) {
        if (timeToFirstTokenMs === null && (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_delta')) {
          timeToFirstTokenMs = Date.now() - started;
        }
        if (event.type !== 'error') {
          if (event.type === 'done') status = 'completed';
          yield withoutProviderDiagnostics(event);
          continue;
        }
        status = event.reason === 'aborted' ? 'stopped' : status === 'refused' ? 'refused' : 'failed';
        // Providers can encode failures inside a successful stream; their raw text never crosses.
        yield { type: 'error', reason: event.reason, error: {
          role: 'assistant', content: [], api: options.model.api, provider: options.model.provider,
          model: options.model.id, timestamp: Date.now(), stopReason: event.reason,
          errorMessage: event.reason === 'aborted' ? 'Stopped' : failure ?? 'OpenRouter request failed',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } };
      }
    } finally {
      const reported = usage as Record<string, unknown> | null;
      const costUsd = finiteNumber(reported?.cost);
      if (admitted) options.ceiling.settle(reservedUsd, costUsd);
      const details = reported?.prompt_tokens_details as Record<string, unknown> | undefined;
      options.onReceipt?.({
        generationId,
        model: options.model.id,
        status,
        inputTokens: finiteNumber(reported?.prompt_tokens) ?? 0,
        outputTokens: finiteNumber(reported?.completion_tokens) ?? 0,
        cacheReadTokens: finiteNumber(details?.cached_tokens) ?? 0,
        costUsd,
        reservedUsd: admitted ? reservedUsd : 0,
        startedAt,
        finishedAt: new Date().toISOString(),
        purpose,
        cacheWriteTokens: finiteNumber(details?.cache_write_tokens) ?? 0,
        cachedTokenRatio: finiteNumber(reported?.prompt_tokens) ? Math.min(1,
          (finiteNumber(details?.cached_tokens) ?? 0) / Number(reported?.prompt_tokens)) : null,
        timeToFirstTokenMs,
      });
    }
  };

  const transport: PiModelTransport = async function* (context, signal) {
    yield* run(context, signal);
  };
  if (!policy) return transport;
  transport.prepare = async (context, signal) => {
    if (preparedSessions.has(signal) || signal.aborted || !promptCacheEnabled()) return;
    preparedSessions.add(signal);
    const prefix = cachePrefixContext(context);
    if (!prefix) return;
    // Warm output is never delivered to the agent or added to its conversation.
    try { for await (const _event of run(prefix, signal, 'prewarm')) { /* receipt owns usage */ } }
    catch { /* Warming is best effort; ordinary turns retain their error handling. */ }
  };
  return transport;
}
