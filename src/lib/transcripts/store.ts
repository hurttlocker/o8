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
  const seen = new Set(current.map((entry) => entry.id));
  const appended: MobileTranscriptEntry[] = [];
  for (const entry of incoming) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    appended.push(entry);
  }
  if (appended.length === 0) return current;
  return [...current, ...appended];
}

interface MergeOptions {
  merge?: TranscriptMerger;
  touchTimestamp?: boolean;
}

class TranscriptStore {
  private readonly slices = new Map<string, TranscriptSlice>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly globalListeners = new Set<GlobalListener>();

  getSlice(key: string | null | undefined): TranscriptSlice {
    if (!key) return EMPTY_SLICE;
    return this.slices.get(key) ?? EMPTY_SLICE;
  }

  setSlice(key: string, slice: TranscriptSlice): void {
    if (!key) return;
    const previous = this.slices.get(key);
    if (previous === slice) return;
    this.slices.set(key, slice);
    this.emit(key, slice);
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
    const merged = merger(previousMessages, entries);
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
    this.slices.set(key, next);
    this.emit(key, next);
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
      return previous;
    }
    const next: TranscriptSlice = {
      messages: previous.messages,
      status,
      lastUpdated: previous.lastUpdated,
      ...(error ? { error } : {}),
    };
    this.slices.set(key, next);
    this.emit(key, next);
    return next;
  }

  subscribe(key: string, listener: Listener): () => void {
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
    if (!this.slices.has(key)) return;
    this.slices.delete(key);
    this.emit(key, EMPTY_SLICE);
  }

  private emit(key: string, slice: TranscriptSlice): void {
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
