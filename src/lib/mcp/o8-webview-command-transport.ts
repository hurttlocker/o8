import type { Socket } from 'node:net';

export interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export function createCodedError(message: string, code?: string): Error {
  const error = new Error(message) as Error & { code?: string };
  if (code) error.code = code;
  return error;
}

export function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

export function isMutationAckTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:timeout waiting for .* response|request timed out|timed out after)/i.test(message);
}

export async function queueCommandWrite(options: {
  socket: Socket;
  pending: Map<string, PendingRequest>;
  command: string;
  payload: Record<string, unknown>;
  authToken?: string;
  timeoutMs: number;
  normalizeConnectionError: (error: Error) => Error;
}): Promise<void> {
  const { socket, pending, command, payload, authToken, timeoutMs, normalizeConnectionError } = options;
  await new Promise<void>((resolve, reject) => {
    const requestId = `${Date.now()}${Math.random().toString(36).slice(2)}`;
    const timeout = setTimeout(() => pending.delete(requestId), timeoutMs);
    pending.set(requestId, {
      resolve: () => clearTimeout(timeout),
      reject: () => clearTimeout(timeout),
      timeout,
    });

    const request = `${JSON.stringify({
      command,
      payload,
      id: requestId,
      ...(authToken ? { authToken } : {}),
    })}\n`;

    socket.write(request, (error) => {
      if (!error) {
        resolve();
        return;
      }
      clearTimeout(timeout);
      pending.delete(requestId);
      reject(normalizeConnectionError(error));
    });
  });
}
