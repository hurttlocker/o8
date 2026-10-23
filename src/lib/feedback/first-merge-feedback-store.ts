'use client';

const KEY = 'o8:first-merge-feedback';
const listeners = new Set<() => void>();

export function readFirstMergeFeedbackSnapshot(): string | null {
  try { return window.localStorage.getItem(KEY); }
  catch { return 'unavailable'; }
}

export function subscribeFirstMergeFeedback(listener: () => void) {
  listeners.add(listener);
  const changed = (event: StorageEvent) => { if (event.key === KEY || event.key === null) listener(); };
  window.addEventListener('storage', changed);
  return () => { listeners.delete(listener); window.removeEventListener('storage', changed); };
}

export function parseFirstMergeFeedbackSnapshot(raw: string | null): { packetId: string; done: boolean } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { packetId?: unknown; done?: unknown } | null;
    return value && typeof value.packetId === 'string' && value.packetId.trim() && typeof value.done === 'boolean'
      ? { packetId: value.packetId, done: value.done } : null;
  } catch { return null; }
}

function write(packetId: string, done: boolean) {
  try { window.localStorage.setItem(KEY, JSON.stringify({ packetId, done })); }
  catch { return; }
  for (const listener of listeners) listener();
}

/** Store only the first observed merge identity and the explicit dismissal/receipt. */
export function claimFirstMergeFeedback(packetId: string) {
  if (readFirstMergeFeedbackSnapshot() === null) write(packetId, false);
}

export function finishFirstMergeFeedback(packetId: string) {
  const record = parseFirstMergeFeedbackSnapshot(readFirstMergeFeedbackSnapshot());
  if (record?.packetId === packetId && !record.done) write(packetId, true);
}
