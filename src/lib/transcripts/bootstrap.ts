import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { transcriptStore, type TranscriptMerger } from './store';

const DEFAULT_LIMIT = 80;
const DEFAULT_CONCURRENCY = 2;

export interface BootstrapOptions {
  limit?: number;
  concurrency?: number;
  merge?: TranscriptMerger;
  signal?: AbortSignal;
  refetchFresh?: boolean;
}

interface MobileHistoryPayload {
  transcript?: MobileTranscriptEntry[];
}

async function fetchSession(
  sessionKey: string,
  limit: number,
  merge: TranscriptMerger | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const existing = transcriptStore.getSlice(sessionKey);
  if (existing.status !== 'fresh') {
    transcriptStore.setStatus(sessionKey, 'loading');
  }
  try {
    const endpoint = `/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=${limit}`;
    const response = await fetch(endpoint, { signal });
    if (!response.ok) {
      transcriptStore.setStatus(sessionKey, 'error', `HTTP ${response.status}`);
      return;
    }
    const data = await response.json() as MobileHistoryPayload;
    const transcript = Array.isArray(data.transcript) ? data.transcript : [];
    transcriptStore.mergeEntries(sessionKey, transcript, merge ? { merge } : undefined);
  } catch (error) {
    if (signal?.aborted) return;
    const message = error instanceof Error ? error.message : 'unknown error';
    transcriptStore.setStatus(sessionKey, 'error', message);
  }
}

export async function bootstrapTranscripts(
  sessionKeys: Array<string | null | undefined>,
  options?: BootstrapOptions,
): Promise<void> {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const concurrency = Math.max(1, options?.concurrency ?? DEFAULT_CONCURRENCY);
  const merge = options?.merge;
  const signal = options?.signal;

  const refetchFresh = options?.refetchFresh ?? false;
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const key of sessionKeys) {
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!refetchFresh && transcriptStore.getSlice(key).status === 'fresh') continue;
    unique.push(key);
  }
  if (unique.length === 0) return;

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < unique.length) {
      if (signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      const key = unique[index];
      if (!key) continue;
      await fetchSession(key, limit, merge, signal);
    }
  };

  const workers: Array<Promise<void>> = [];
  const poolSize = Math.min(concurrency, unique.length);
  for (let i = 0; i < poolSize; i += 1) {
    workers.push(worker());
  }
  await Promise.allSettled(workers);
}
