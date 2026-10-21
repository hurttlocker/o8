export const COMPOSER_QUEUE_REQUEST_TIMEOUT_MS = 15_000;

export class ComposerQueueRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Bound both response headers and body. A timeout is uncertainty, never a replay instruction. */
export async function composerQueueRequest<T>(url: string, init: RequestInit, timeoutMessage: string): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { ...init, signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new ComposerQueueRequestError(body.error || 'Unable to update queued messages.', response.status);
        return body as T;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(timeoutMessage));
          controller.abort();
        }, COMPOSER_QUEUE_REQUEST_TIMEOUT_MS);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
