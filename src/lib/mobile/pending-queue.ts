/**
 * Mobile pending-message queue.
 *
 * When the WS or LLM proxy is offline, user-typed messages get appended here
 * instead of dying in the textbox. On reconnect the consumer drains the queue
 * in FIFO order and commits each item over its own channel.
 *
 * Storage key: `o8:mobile:<channel>-pending:<tabId>` (per packet #646 spec).
 * Cap: 10 items per (channel, tabId) — older items are not auto-evicted; the
 * UI surfaces a "Queue full" toast and the consumer refuses to enqueue more.
 * Stale: items older than 1h surface a Retry/Discard prompt instead of
 * auto-replaying.
 *
 * Only user-typed messages belong here. Tool-result acks, interrupts, and any
 * other ambient WS traffic must NOT be queued — they are channel-specific
 * control commands that don't make sense to replay later.
 */

export type PendingQueueChannel = 'orchestrator' | 'assistant';

export interface PendingQueueItem {
  id: string;
  text: string;
  queuedAt: number;
}

export const PENDING_QUEUE_MAX = 10;
export const PENDING_QUEUE_STALE_MS = 60 * 60 * 1000;

function storageKey(channel: PendingQueueChannel, tabId: string): string {
  return `o8:mobile:${channel}-pending:${tabId}`;
}

function readRaw(channel: PendingQueueChannel, tabId: string): PendingQueueItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(storageKey(channel, tabId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const items: PendingQueueItem[] = [];
    for (const candidate of parsed) {
      if (!candidate || typeof candidate !== 'object') continue;
      const record = candidate as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id : '';
      const text = typeof record.text === 'string' ? record.text : '';
      const queuedAt = typeof record.queuedAt === 'number' ? record.queuedAt : NaN;
      if (!id || !text || !Number.isFinite(queuedAt)) continue;
      items.push({ id, text, queuedAt });
    }
    return items;
  } catch {
    return [];
  }
}

function writeRaw(
  channel: PendingQueueChannel,
  tabId: string,
  items: PendingQueueItem[],
): void {
  if (typeof window === 'undefined') return;
  try {
    if (items.length === 0) {
      window.localStorage.removeItem(storageKey(channel, tabId));
      return;
    }
    window.localStorage.setItem(storageKey(channel, tabId), JSON.stringify(items));
  } catch {
    // Ignore quota / serialization errors so the surface stays usable.
  }
}

export function generatePendingId(): string {
  return `pending:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

export function getPendingQueue(
  channel: PendingQueueChannel,
  tabId: string,
): PendingQueueItem[] {
  return readRaw(channel, tabId);
}

/**
 * Appends a new pending item. Returns `null` when the queue is full so the
 * caller can surface a "Queue full" toast — we do not silently drop messages.
 */
export function enqueuePending(
  channel: PendingQueueChannel,
  tabId: string,
  text: string,
  id: string = generatePendingId(),
): PendingQueueItem | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const current = readRaw(channel, tabId);
  if (current.length >= PENDING_QUEUE_MAX) return null;
  if (current.some((item) => item.id === id)) {
    return current.find((item) => item.id === id) ?? null;
  }
  const item: PendingQueueItem = { id, text: trimmed, queuedAt: Date.now() };
  writeRaw(channel, tabId, [...current, item]);
  return item;
}

export function removePending(
  channel: PendingQueueChannel,
  tabId: string,
  id: string,
): void {
  const current = readRaw(channel, tabId);
  const next = current.filter((item) => item.id !== id);
  if (next.length === current.length) return;
  writeRaw(channel, tabId, next);
}

/**
 * Marks a queued item for an explicit retry without changing its idempotency
 * identity. The server reserves this id for 24 hours, so a new id could turn
 * a retry into a second orchestrator turn.
 */
export function refreshPending(
  channel: PendingQueueChannel,
  tabId: string,
  id: string,
  now = Date.now(),
): PendingQueueItem | null {
  const current = readRaw(channel, tabId);
  const index = current.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const refreshed = { ...current[index], queuedAt: now };
  const next = current.slice();
  next[index] = refreshed;
  writeRaw(channel, tabId, next);
  return refreshed;
}

export function clearPending(channel: PendingQueueChannel, tabId: string): void {
  writeRaw(channel, tabId, []);
}

export function isPendingStale(item: PendingQueueItem, now = Date.now()): boolean {
  return now - item.queuedAt >= PENDING_QUEUE_STALE_MS;
}
