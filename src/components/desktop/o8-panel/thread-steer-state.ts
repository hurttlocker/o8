'use client';

import { useCallback, useSyncExternalStore } from 'react';

export interface PendingThreadSteer { id: string; message: string; }

const pending = new Map<string, PendingThreadSteer | null>();
const listeners = new Set<() => void>();
const storageKey = (packetId: string) => `o8:pending-thread-steer:${encodeURIComponent(packetId)}`;

export function readPendingThreadSteer(packetId: string): PendingThreadSteer | null {
  if (!pending.has(packetId)) {
    let value: PendingThreadSteer | null = null;
    try {
      const stored = JSON.parse(window.sessionStorage.getItem(storageKey(packetId)) ?? 'null') as Partial<PendingThreadSteer> | null;
      if (stored && typeof stored.id === 'string' && typeof stored.message === 'string') value = { id: stored.id, message: stored.message };
    } catch { /* Storage availability is checked again before issuing a mutation. */ }
    pending.set(packetId, value);
  }
  return pending.get(packetId) ?? null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function savePendingThreadSteer(packetId: string, value: PendingThreadSteer) {
  window.sessionStorage.setItem(storageKey(packetId), JSON.stringify(value));
  pending.set(packetId, value);
  for (const listener of listeners) listener();
}

export function clearPendingThreadSteer(packetId: string, requestId: string) {
  // A second detail may receive an older receipt after a new steer has begun.
  if (readPendingThreadSteer(packetId)?.id !== requestId) return;
  window.sessionStorage.removeItem(storageKey(packetId));
  pending.set(packetId, null);
  for (const listener of listeners) listener();
}

/** Keep an unsettled mutation across detail navigation and webview reloads. */
export function usePendingThreadSteer(packetId: string | null) {
  const getSnapshot = useCallback(() => packetId ? readPendingThreadSteer(packetId) : null, [packetId]);
  const request = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const save = useCallback((value: PendingThreadSteer) => {
    if (!packetId) return;
    // Persist before an RPC; a storage failure prevents issuing a fresh mutation.
    savePendingThreadSteer(packetId, value);
  }, [packetId]);
  const clear = useCallback((requestId: string) => {
    if (packetId) clearPendingThreadSteer(packetId, requestId);
  }, [packetId]);
  return { request, save, clear, readCurrent: getSnapshot };
}
