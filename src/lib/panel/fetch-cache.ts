import { ipcFetch } from '@/lib/tauri/ipc-fetch';

const inflight = new Map<string, { promise: Promise<Response>; timestamp: number }>();
const DEDUP_WINDOW_MS = 150;

export async function fetchOnce(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method || 'GET';
  if (method !== 'GET') return fetch(url, init);

  const existing = inflight.get(url);
  if (existing && Date.now() - existing.timestamp < DEDUP_WINDOW_MS) {
    return existing.promise.then((response) => response.clone());
  }

  // ipcFetch: uses Tauri IPC for mapped endpoints, falls back to HTTP
  const promise = ipcFetch(url, init);
  inflight.set(url, { promise, timestamp: Date.now() });
  promise.finally(() => {
    setTimeout(() => inflight.delete(url), DEDUP_WINDOW_MS);
  });
  // EVERY caller gets a clone — the cached original is never read. Handing
  // the first caller the original meant its res.json() disturbed the body,
  // and any dedup hit inside the 150ms window then died at clone() with
  // "Body is disturbed or locked" — an unhandled rejection that silently
  // killed whichever flow deduped second (report D3YPBP, crash log v0.1.591).
  return promise.then((response) => response.clone());
}
