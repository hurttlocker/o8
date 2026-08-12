import { randomUUID } from 'node:crypto';
import {
  actionReceiptIsInProgress,
  CorrelatedActionUnsettledError,
  type CorrelatedActionPayload,
} from '@/lib/orchestrator/action-receipt';

export type McpMutationCorrelationField = 'clientMutationId' | 'idempotencyKey';

export interface McpCorrelatedMutationOptions<TPayload extends CorrelatedActionPayload> {
  body: Record<string, unknown>;
  correlationField: McpMutationCorrelationField;
  send(requestBody: string): Promise<Response>;
  timeoutMs?: number;
  pollMs?: number;
  parseError?(response: Response, payload: TPayload | null): Error;
}

interface McpApiCorrelatedMutationOptions<TPayload extends CorrelatedActionPayload>
  extends Omit<McpCorrelatedMutationOptions<TPayload>, 'send'> {
  url: string;
  authorization?: string;
  requestTimeoutMs?: number;
}

const DEFAULT_MCP_RECEIPT_WAIT_MS = 5 * 60_000;
const DEFAULT_MCP_RECEIPT_POLL_MS = 750;

function wait(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function defaultHttpError(response: Response, payload: unknown): Error {
  const error = payload && typeof payload === 'object'
    ? (payload as { error?: unknown }).error
    : null;
  const message = typeof error === 'string'
    ? error
    : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : `MCP mutation failed with HTTP ${response.status}.`;
  const httpError = new Error(message) as Error & { noRetry?: boolean };
  httpError.noRetry = true;
  return httpError;
}

/**
 * Owns one MCP mutation UUID and replays its exact serialized body until the
 * persisted receipt settles. A transport failure or HTTP 202 never mints a
 * second identity, so the caller observes the original side effect or fails
 * closed with an unsettled receipt.
 */
export async function pollCorrelatedMcpMutation<
  TPayload extends CorrelatedActionPayload = CorrelatedActionPayload,
>(options: McpCorrelatedMutationOptions<TPayload>): Promise<TPayload> {
  const suppliedCorrelation = options.body[options.correlationField];
  const correlationId = typeof suppliedCorrelation === 'string' && suppliedCorrelation.trim()
    ? suppliedCorrelation.trim()
    : randomUUID();
  const requestBody = JSON.stringify({
    ...options.body,
    [options.correlationField]: correlationId,
  });
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_MCP_RECEIPT_WAIT_MS);
  let lastError: unknown = null;

  do {
    try {
      const response = await options.send(requestBody);
      const payload = await response.json().catch(() => null) as TPayload | null;
      if (!response.ok) {
        const error = options.parseError?.(response, payload) ?? defaultHttpError(response, payload);
        (error as Error & { noRetry?: boolean }).noRetry = true;
        throw error;
      }
      lastError = null;
      if (
        payload && typeof payload.ok === 'boolean' &&
        !actionReceiptIsInProgress(response.status, payload.result ?? payload)
      ) {
        return payload;
      }
    } catch (error) {
      lastError = error;
      if (error instanceof Error && 'noRetry' in error) throw error;
    }

    if (Date.now() >= deadline) {
      throw new CorrelatedActionUnsettledError(lastError);
    }
    await wait(options.pollMs ?? DEFAULT_MCP_RECEIPT_POLL_MS);
  } while (true);
}

export function pollCorrelatedMcpApiMutation<
  TPayload extends CorrelatedActionPayload = CorrelatedActionPayload,
>(options: McpApiCorrelatedMutationOptions<TPayload>): Promise<TPayload> {
  return pollCorrelatedMcpMutation({
    ...options,
    send: async (requestBody) => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        options.requestTimeoutMs ?? 15_000,
      );
      try {
        return await fetch(options.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(options.authorization ? { Authorization: options.authorization } : {}),
          },
          body: requestBody,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
