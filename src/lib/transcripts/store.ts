import type { MobileTranscriptEntry } from '@/lib/mobile/types';

export type TranscriptSliceStatus = 'idle' | 'loading' | 'fresh' | 'error';

export interface TranscriptSlice {
  messages: MobileTranscriptEntry[];
  status: TranscriptSliceStatus;
  lastUpdated: number;
  error?: string;
}

export type TranscriptMerger = (
  current: MobileTranscriptEntry[],
  incoming: MobileTranscriptEntry[],
) => MobileTranscriptEntry[];

type Listener = (slice: TranscriptSlice) => void;
type GlobalListener = (key: string, slice: TranscriptSlice) => void;

const EMPTY_MESSAGES: MobileTranscriptEntry[] = [];

export const MAX_TRANSCRIPT_ENTRIES_PER_SLICE = 200;
export const MAX_TRANSCRIPT_STORE_SLICES = 32;
export const TRANSCRIPT_PRESENTATION_INTERVAL_MS = 250;

export function retainTranscriptEntries(entries: MobileTranscriptEntry[]): MobileTranscriptEntry[] {
  if (entries.length <= MAX_TRANSCRIPT_ENTRIES_PER_SLICE) return entries;
  return entries.slice(-MAX_TRANSCRIPT_ENTRIES_PER_SLICE);
}

// Snapshots arrive as fresh JSON objects. Compare every field, including nested
// receipts and tool data, so sharing never hides an edit outside the prose text.
function sameTranscriptValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameTranscriptValue(value, right[index]));
  }
  if (Object.getPrototypeOf(left) !== Object.prototype || Object.getPrototypeOf(right) !== Object.prototype) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every(key => Object.hasOwn(b, key) && sameTranscriptValue(a[key], b[key]));
}

function shareTranscriptEntries(previous: MobileTranscriptEntry[] | undefined, incoming: MobileTranscriptEntry[]): MobileTranscriptEntry[] {
  if (!previous || previous === incoming) return incoming;
  const byId = new Map(previous.map(entry => [entry.id, entry]));
  const shared = incoming.map(entry => {
    const prior = byId.get(entry.id);
    return prior && sameTranscriptValue(prior, entry) ? prior : entry;
  });
  return shared.length === previous.length && shared.every((entry, index) => entry === previous[index]) ? previous : shared;
}

export function isAssistantTextEdit(previous: TranscriptSlice | undefined, next: TranscriptSlice): boolean {
  if (previous?.status !== 'fresh' || next.status !== 'fresh' || !next.messages.length
    || previous.messages.length !== next.messages.length) return false;
  const last = next.messages.length - 1;
  if (!next.messages.every((entry, index) => index === last || entry === previous.messages[index])) return false;
  const before = previous.messages[last];
  const after = next.messages[last];
  if (before.id !== after.id || before.text === after.text || after.role !== 'assistant'
    || after.receipt || after.type && after.type !== 'message') return false;
  const metadata = { ...before, text: after.text };
  if (Object.hasOwn(after, 'persistedVersion')) metadata.persistedVersion = after.persistedVersion;
  else delete metadata.persistedVersion;
  return sameTranscriptValue(metadata, after);
}

const EMPTY_SLICE: TranscriptSlice = Object.freeze({
  messages: EMPTY_MESSAGES,
  status: 'idle',
  lastUpdated: 0,
}) as TranscriptSlice;

function defaultMerge(
  current: MobileTranscriptEntry[],
  incoming: MobileTranscriptEntry[],
): MobileTranscriptEntry[] {
  if (current.length === 0) return incoming;
  if (incoming.length === 0) return current;
  const indices = new Map(current.map((entry, index) => [entry.id, index]));
  const merged = [...current];
  let changed = false;
  for (const entry of incoming) {
    const index = indices.get(entry.id);
    if (index === undefined) {
      indices.set(entry.id, merged.length);
      merged.push(entry);
      changed = true;
      continue;
    }
    if (merged[index] !== entry) {
      merged[index] = entry;
      changed = true;
    }
  }
  return changed ? merged : current;
}

interface MergeOptions {
  merge?: TranscriptMerger;
  touchTimestamp?: boolean;
  deferNotifications?: boolean;
}

export class TranscriptStore {
  private readonly slices = new Map<string, TranscriptSlice>();
  private readonly presentedSlices = new Map<string, TranscriptSlice>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly globalListeners = new Set<GlobalListener>();
  private readonly pendingNotifications = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly accessOrder = new Map<string, number>();
  private accessOrdinal = 0;

  private touch(key: string): void {
    this.accessOrdinal += 1;
    this.accessOrder.set(key, this.accessOrdinal);
  }

  private evictUnusedSlices(): void {
    while (this.slices.size > MAX_TRANSCRIPT_STORE_SLICES) {
      const candidate = [...this.slices.keys()]
        .filter((key) => (this.listeners.get(key)?.size ?? 0) === 0)
        .sort((left, right) => (this.accessOrder.get(left) ?? 0) - (this.accessOrder.get(right) ?? 0))[0];
      if (!candidate) return;
      this.cancelNotification(candidate);
      this.slices.delete(candidate);
      this.presentedSlices.delete(candidate);
      this.accessOrder.delete(candidate);
    }
  }

  getSlice(key: string | null | undefined): TranscriptSlice {
    if (!key) return EMPTY_SLICE;
    const slice = this.slices.get(key);
    if (!slice) return EMPTY_SLICE;
    this.touch(key);
    return slice;
  }

  getPresentedSlice(key: string | null | undefined): TranscriptSlice {
    if (!key) return EMPTY_SLICE;
    const slice = this.presentedSlices.get(key);
    if (!slice) return this.getSlice(key);
    this.touch(key);
    return slice;
  }

  setSlice(key: string, slice: TranscriptSlice, options?: Pick<MergeOptions, 'deferNotifications'>): void {
    if (!key) return;
    const previous = this.slices.get(key);
    const messages = shareTranscriptEntries(previous?.messages, retainTranscriptEntries(slice.messages));
    const boundedSlice = messages === slice.messages ? slice : { ...slice, messages };
    this.touch(key);
    if (previous === boundedSlice) return;
    this.slices.set(key, boundedSlice);
    this.evictUnusedSlices();
    this.emit(key, boundedSlice, Boolean(options?.deferNotifications && isAssistantTextEdit(previous, boundedSlice)));
  }

  mergeEntries(
    key: string,
    entries: MobileTranscriptEntry[],
    options?: MergeOptions,
  ): TranscriptSlice {
    if (!key) return EMPTY_SLICE;
    const previous = this.slices.get(key);
    const merger = options?.merge ?? defaultMerge;
    const previousMessages = previous?.messages ?? [];
    const merged = shareTranscriptEntries(previous?.messages, retainTranscriptEntries(merger(previousMessages, entries)));
    if (previous && merged === previousMessages && previous.status === 'fresh') {
      return previous;
    }
    const next: TranscriptSlice = {
      messages: merged,
      status: 'fresh',
      lastUpdated: options?.touchTimestamp === false
        ? (previous?.lastUpdated ?? Date.now())
        : Date.now(),
    };
    this.touch(key);
    this.slices.set(key, next);
    this.evictUnusedSlices();
    this.emit(key, next, Boolean(options?.deferNotifications && isAssistantTextEdit(previous, next)));
    return next;
  }

  setStatus(
    key: string,
    status: TranscriptSliceStatus,
    error?: string,
  ): TranscriptSlice {
    if (!key) return EMPTY_SLICE;
    const previous = this.slices.get(key) ?? EMPTY_SLICE;
    if (previous.status === status && previous.error === error) {
      if (this.pendingNotifications.has(key)) this.emit(key, previous);
      return previous;
    }
    const next: TranscriptSlice = {
      messages: previous.messages,
      status,
      lastUpdated: previous.lastUpdated,
      ...(error ? { error } : {}),
    };
    this.touch(key);
    this.slices.set(key, next);
    this.evictUnusedSlices();
    this.emit(key, next);
    return next;
  }

  subscribe(key: string, listener: Listener): () => void {
    if (this.slices.has(key)) this.touch(key);
    let bucket = this.listeners.get(key);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(key, bucket);
    }
    bucket.add(listener);
    return () => {
      const current = this.listeners.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(key);
        if (!this.slices.has(key)) this.accessOrder.delete(key);
        this.evictUnusedSlices();
      }
    };
  }

  subscribeAll(listener: GlobalListener): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  clear(key: string): void {
    this.accessOrder.delete(key);
    if (!this.slices.has(key)) return;
    this.slices.delete(key);
    this.emit(key, EMPTY_SLICE);
  }

  private cancelNotification(key: string): void {
    const timer = this.pendingNotifications.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.pendingNotifications.delete(key);
  }

  private emit(key: string, slice: TranscriptSlice, defer = false): void {
    // Cache every snapshot immediately. Only presentation of an in-place text
    // edit is coalesced; structural changes and status/receipt updates flush it.
    if (defer && ((this.listeners.get(key)?.size ?? 0) > 0 || this.globalListeners.size > 0)) {
      if (!this.pendingNotifications.has(key)) {
        this.pendingNotifications.set(key, setTimeout(() => {
          this.pendingNotifications.delete(key);
          const latest = this.slices.get(key);
          if (latest) this.emit(key, latest);
        }, TRANSCRIPT_PRESENTATION_INTERVAL_MS));
      }
      return;
    }
    this.cancelNotification(key);
    if (this.slices.has(key)) this.presentedSlices.set(key, slice);
    else this.presentedSlices.delete(key);
    const bucket = this.listeners.get(key);
    if (bucket) {
      for (const listener of bucket) listener(slice);
    }
    if (this.globalListeners.size > 0) {
      for (const listener of this.globalListeners) listener(key, slice);
    }
  }
}

export const transcriptStore = new TranscriptStore();

export const EMPTY_TRANSCRIPT_SLICE = EMPTY_SLICE;
