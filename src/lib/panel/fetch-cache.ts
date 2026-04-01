const inflight = new Map<string, { promise: Promise<Response>; timestamp: number }>();
const DEDUP_WINDOW_MS = 150;

export async function fetchOnce(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method || 'GET';
  if (method !== 'GET') return fetch(url, init);

  const existing = inflight.get(url);
  if (existing && Date.now() - existing.timestamp < DEDUP_WINDOW_MS) {
    return existing.promise.then((response) => response.clone());
  }

  const promise = fetch(url, init);
  inflight.set(url, { promise, timestamp: Date.now() });
  promise.finally(() => {
    setTimeout(() => inflight.delete(url), DEDUP_WINDOW_MS);
  });
  return promise;
}
