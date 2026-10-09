/**
 * The o8 managed model as a pi-ai provider, for the durable Symon brain (#3453).
 *
 * Model calls go through the same managed transport the built-in Pi worker
 * uses: the route and its credential headers are resolved by the host on each
 * call and never enter the harness, and provider diagnostics are replaced by
 * bounded text before an event is stored.
 */

import {
  createAssistantMessageEventStream,
  createProvider,
  type AssistantMessage,
  type Model,
  type Provider,
  type ProviderStreams,
} from '@earendil-works/pi-ai';
import type { Context as PiCompatContext } from '@earendil-works/pi-ai/compat';
import { O8_MANAGED_PI_MODEL } from '@/lib/pi/sdk/live-contract';
import { createManagedPiTransport, type ManagedPiTransportOptions } from '@/lib/pi/sdk/transport';

export const SYMON_MANAGED_PROVIDER_ID = O8_MANAGED_PI_MODEL.provider;

/**
 * Symon's view of the managed model. A smaller window than the worker's keeps
 * a long conversation compacting well before a request grows large.
 */
export const SYMON_MANAGED_MODEL: Model<'openai-completions'> = {
  ...O8_MANAGED_PI_MODEL,
  contextWindow: 24_000,
};

function failedMessage(model: Model<'openai-completions'>, errorMessage: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    stopReason: 'error',
    errorMessage,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

export function createSymonManagedProvider(
  options: Omit<ManagedPiTransportOptions, 'model'> = {},
): Provider<'openai-completions'> {
  const transport = createManagedPiTransport({ ...options, model: SYMON_MANAGED_MODEL });
  const run: ProviderStreams['streamSimple'] = (_model, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();
    const signal = streamOptions?.signal ?? new AbortController().signal;
    void (async () => {
      try {
        for await (const event of transport(context as unknown as PiCompatContext, signal)) stream.push(event);
        stream.end();
      } catch (error) {
        // Setup failures (no entitlement, an invalid route) are o8's own text;
        // anything else stays out of the transcript.
        const text = error instanceof Error && /^Managed inference /.test(error.message)
          ? error.message : 'Managed inference failed';
        const message = failedMessage(SYMON_MANAGED_MODEL, signal.aborted ? 'Stopped' : text);
        stream.push({ type: 'error', reason: signal.aborted ? 'aborted' : 'error', error: message });
        stream.end(message);
      }
    })();
    return stream;
  };
  return createProvider({
    id: SYMON_MANAGED_PROVIDER_ID,
    name: 'o8 managed',
    baseUrl: SYMON_MANAGED_MODEL.baseUrl,
    // The host transport resolves the route and its headers on every call.
    auth: { apiKey: { name: 'o8 managed', resolve: async () => ({ auth: {} }) } },
    models: [SYMON_MANAGED_MODEL],
    api: { stream: run, streamSimple: run },
  });
}
