import { streamSimple, type Context, type Model, type AssistantMessageEvent } from '@earendil-works/pi-ai/compat';
import type { InferenceRoute } from '@/lib/cortex/qa/llm/inference-route';

export type PiModelTransport = (context: Context, signal: AbortSignal) => AsyncIterable<AssistantMessageEvent>;
export interface ManagedPiTransportOptions {
  model: Model<'openai-completions'>;
  resolveRoute?: () => Promise<InferenceRoute | null>;
  fetch?: typeof fetch;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Host-only observer before Pi fills in missing usage fields. Never forwarded to the worker. */
  observeRawUsage?: (usage: unknown) => void;
}

export const PI_ALLOWANCE_EXHAUSTED_MESSAGE = 'Your daily o8 model allowance is used up. It resets at midnight UTC.';

/** The relay's over-cap reply is small JSON. Read at most 4 KiB, and stop reading when the run stops. */
async function isDailyCapResponse(response: Response, signal: AbortSignal): Promise<boolean> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const stop = () => { void reader?.cancel().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    reader = response.body?.getReader();
    if (!reader || signal.aborted) return false;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) return false;
      chunks.push(value);
    }
    return (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: unknown }).error === 'daily cap reached';
  } catch {
    return false;
  } finally {
    signal.removeEventListener('abort', stop);
    await reader?.cancel().catch(() => {});
  }
}

/** Credentials never cross into the SDK worker. Re-resolve entitlement each call. */
export function createManagedPiTransport(options: ManagedPiTransportOptions): PiModelTransport {
  return async function* (context, signal) {
    signal.throwIfAborted();
    const route = await (options.resolveRoute ?? (async () => {
      const { resolvePiInferenceRoute } = await import('@/lib/cortex/qa/llm/inference-route');
      return resolvePiInferenceRoute();
    }))();
    if (!route || route.via !== 'proxy') throw new Error('Managed inference entitlement is required');
    const url = new URL(route.url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Managed inference route is invalid');
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000);
    const requestSignal = AbortSignal.any([signal, timeout]);
    let responseStatus: number | undefined;
    let allowanceExhausted = false;
    const guardedFetch: typeof fetch = async (_input, init) => {
      requestSignal.throwIfAborted();
      // Pi's OpenAI adapter constructs /chat/completions; only its body is reused.
      // Route, credential headers, method and redirect policy remain host-owned.
      const response = await (options.fetch ?? fetch)(route.url, {
        method: 'POST', headers: route.headers, body: init?.body,
        redirect: 'error', signal: requestSignal,
      });
      responseStatus = response.status;
      if (!response.ok) {
        // An exhausted allowance stays exhausted until the relay's daily reset; Pi
        // retries are off, so this one failed call ends the run.
        if (response.status === 402) allowanceExhausted = await isDailyCapResponse(response, requestSignal);
        else await response.body?.cancel();
        throw new Error(`Managed inference rejected request (${response.status})`);
      }
      return response;
    };
    const stream = streamSimple(options.model, context, {
      apiKey: 'host-transport-only', fetch: guardedFetch, signal: requestSignal,
      onProviderStreamEvent: (chunk) => {
        if (chunk && typeof chunk === 'object' && 'usage' in chunk && chunk.usage != null) {
          options.observeRawUsage?.(chunk.usage);
        }
      },
      maxRetries: 0, maxTokens: options.maxOutputTokens ?? 4096, transport: 'sse',
    });
    for await (const event of stream) {
      if (event.type !== 'error') { yield event; continue; }
      // Providers can encode failures inside a successful SSE response. Pi yields
      // these as events, so catch-only redaction would leak their raw bodies.
      yield { type: 'error', reason: event.reason, error: {
        role: 'assistant', content: [], api: options.model.api, provider: options.model.provider,
        model: options.model.id, timestamp: Date.now(), stopReason: event.reason,
        errorMessage: event.reason === 'aborted' ? 'Stopped' : allowanceExhausted ? PI_ALLOWANCE_EXHAUSTED_MESSAGE : responseStatus && responseStatus !== 200
          ? `Managed inference rejected request (${responseStatus})` : 'Managed inference failed',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } };
    }
  };
}
