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

/** Shown when the relay's over-cap reply carries no period or reset time. */
export const PI_ALLOWANCE_EXHAUSTED_MESSAGE = 'Your daily o8 model allowance is used up. It resets at midnight UTC.';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];
const WEEKLY_NO_RESET_MESSAGE = 'Your weekly o8 model allowance is used up. It resets Monday at 00:00 UTC.';
const DATED_ALLOWANCE_MESSAGE = new RegExp(`^Your (?:daily |weekly )?o8 model allowance is used up\\. It resets `
  + `(?:${WEEKDAYS.join('|')}), (?:${MONTHS.join('|')}) (?:[1-9]|[12]\\d|3[01]) at (?:[01]\\d|2[0-3]):[0-5]\\d UTC\\.$`);

/** True only for text `piAllowanceExhaustedMessage` can produce, so the session lets exactly these through. */
export function isPiAllowanceMessage(text: string): boolean {
  return text === PI_ALLOWANCE_EXHAUSTED_MESSAGE || text === WEEKLY_NO_RESET_MESSAGE || DATED_ALLOWANCE_MESSAGE.test(text);
}

/**
 * The relay meters paid plans per UTC week (reset Monday 00:00 UTC) and the free
 * plan per day. Its 402 body names the `period` and `resetsAt`; either may be absent.
 */
export function piAllowanceExhaustedMessage(cap: { period?: unknown; resetsAt?: unknown } = {}): string {
  const period = cap.period === 'week' ? 'weekly' : cap.period === 'day' ? 'daily' : null;
  const at = typeof cap.resetsAt === 'string' ? new Date(cap.resetsAt) : null;
  if (at && Number.isFinite(at.getTime())) {
    const time = `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
    return `Your ${period ? `${period} ` : ''}o8 model allowance is used up. It resets ${WEEKDAYS[at.getUTCDay()]}, `
      + `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()} at ${time} UTC.`;
  }
  if (period === 'weekly') return WEEKLY_NO_RESET_MESSAGE;
  return PI_ALLOWANCE_EXHAUSTED_MESSAGE;
}

/**
 * The relay's over-cap reply is small JSON. Read at most 4 KiB, and stop reading
 * when the run stops. Returns the user-facing message, or null for any other 402.
 */
async function allowanceExhaustedMessage(response: Response, signal: AbortSignal): Promise<string | null> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const stop = () => { void reader?.cancel().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    reader = response.body?.getReader();
    if (!reader || signal.aborted) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) return null;
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: unknown; period?: unknown; resetsAt?: unknown };
    return body.error === 'daily cap reached' ? piAllowanceExhaustedMessage(body) : null;
  } catch {
    return null;
  } finally {
    signal.removeEventListener('abort', stop);
    await reader?.cancel().catch(() => {});
  }
}

/**
 * Pi passes one mutable message as `partial` on every event and writes raw
 * provider error text into it on failure. Events queued before that failure are
 * forwarded later, so each one gets a copy without the diagnostic field.
 */
function withoutProviderDiagnostics(event: AssistantMessageEvent): AssistantMessageEvent {
  if (!('partial' in event)) return event;
  const { errorMessage: _providerText, ...partial } = event.partial;
  return { ...event, partial };
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
    let allowanceExhausted: string | null = null;
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
        // An exhausted allowance stays exhausted until the relay's reset; Pi
        // retries are off, so this one failed call ends the run.
        if (response.status === 402) allowanceExhausted = await allowanceExhaustedMessage(response, requestSignal);
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
      if (event.type !== 'error') { yield withoutProviderDiagnostics(event); continue; }
      // Providers can encode failures inside a successful SSE response. Pi yields
      // these as events, so catch-only redaction would leak their raw bodies.
      yield { type: 'error', reason: event.reason, error: {
        role: 'assistant', content: [], api: options.model.api, provider: options.model.provider,
        model: options.model.id, timestamp: Date.now(), stopReason: event.reason,
        errorMessage: event.reason === 'aborted' ? 'Stopped' : allowanceExhausted ?? (responseStatus && responseStatus !== 200
          ? `Managed inference rejected request (${responseStatus})` : 'Managed inference failed'),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } };
    }
  };
}
