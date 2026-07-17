import { ipcFetch } from '@/lib/tauri/ipc-fetch';

const inflight = new Map<string, { promise: Promise<Response>; timestamp: number }>();
const DEDUP_WINDOW_MS = 150;

interface SwrEntry<T> {
  data?: T;
  promise?: Promise<T>;
}

const swrEntries = new Map<string, SwrEntry<unknown>>();
const swrListeners = new Map<string, Set<() => void>>();

function notifySWR(key: string) {
  swrListeners.get(key)?.forEach((listener) => listener());
}

/** Returns the last known value synchronously while a single background refresh runs. */
export function getSWR<T>(key: string): { data?: T; stale: boolean } {
  const entry = swrEntries.get(key) as SwrEntry<T> | undefined;
  return { data: entry?.data, stale: Boolean(entry?.promise) || !entry?.data };
}

/** Seeds a synchronous snapshot when a surface already has fresh data in memory. */
export function setSWR<T>(key: string, data: T): void {
  const entry = (swrEntries.get(key) ?? {}) as SwrEntry<T>;
  entry.data = data;
  swrEntries.set(key, entry);
  notifySWR(key);
}

export function refreshSWR<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const entry = (swrEntries.get(key) ?? {}) as SwrEntry<T>;
  if (entry.promise) return entry.promise;
  entry.promise = fetcher()
    .then((data) => {
      entry.data = data;
      return data;
    })
    .finally(() => {
      entry.promise = undefined;
      swrEntries.set(key, entry);
      notifySWR(key);
    });
  swrEntries.set(key, entry);
  return entry.promise;
}

export function fetchSWRJson<T>(key: string, url: string, init?: RequestInit): Promise<T> {
  return refreshSWR(key, async () => {
    const response = await fetchOnce(url, init);
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    return response.json() as Promise<T>;
  });
}

export function subscribeSWR(key: string, listener: () => void): () => void {
  const listeners = swrListeners.get(key) ?? new Set<() => void>();
  listeners.add(listener);
  swrListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) swrListeners.delete(key);
  };
}

/** Remove matching snapshots after mutations or lifecycle reconciliation. */
export function invalidateSWR(...keys: string[]): void {
  for (const key of keys) {
    for (const cachedKey of swrEntries.keys()) {
      if (cachedKey === key || cachedKey.startsWith(`${key}:`)) {
        swrEntries.delete(cachedKey);
        notifySWR(cachedKey);
      }
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('o8:lifecycle-reconcile', () => invalidateSWR('panel:repos', 'panel:workspaces', 'lanes'));
  window.addEventListener('o8:repos-changed', () => invalidateSWR('panel:repos'));
  window.addEventListener('o8:invalidate', (event) => {
    const queryKey = (event as CustomEvent).detail?.queryKey as string[] | undefined;
    if (queryKey?.length) invalidateSWR(queryKey.join(':'));
  });
}

export async function fetchOnce(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method || 'GET';
  if (method !== 'GET') return fetch(url, init);

  // Join an identical GET for its WHOLE in-flight duration, not just a 150ms
  // start window. During the boot storm the same URL is requested repeatedly
  // over several seconds (inventory ×4 spread across 2-7s) while the first
  // request is still on the wire — the old timestamp check let every one of
  // them open a NEW socket, starving the webview's per-host pool (measured
  // 8-9.5s pure queue stall on trivial routes, prod boot 2026-07-17). The
  // settle timeout below still bounds the post-completion dedup tail to
  // DEDUP_WINDOW_MS, so a deliberate refetch after a mutation stays fresh.
  // Age cap: a wedged request must not trap every future GET of its URL in a
  // dead join — after 20s, later callers start a fresh request (which also
  // replaces the map entry).
  const existing = inflight.get(url);
  if (existing && Date.now() - existing.timestamp < 20000) {
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
