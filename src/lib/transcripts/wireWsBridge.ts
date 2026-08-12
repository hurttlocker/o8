import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { transcriptStore, type TranscriptMerger } from './store';

export interface TranscriptWsCallbacks {
  onHistoryUpdate: (
    sessionKey: string,
    entries: Array<Record<string, unknown>>,
    replace?: boolean,
  ) => void;
}

export interface TranscriptWsBridgeOptions {
  merge?: TranscriptMerger;
}

interface ListenerRegistrar {
  addListener: (callbacks: TranscriptWsCallbacks) => () => void;
}

function handleHistoryUpdate(
  sessionKey: string,
  entries: Array<Record<string, unknown>>,
  replace: boolean | undefined,
  merge: TranscriptMerger | undefined,
): void {
  if (!sessionKey) return;
  if (!Array.isArray(entries) || (entries.length === 0 && !replace)) return;
  const typed = entries as unknown as MobileTranscriptEntry[];
  if (replace) {
    transcriptStore.setSlice(sessionKey, {
      messages: typed,
      status: 'fresh',
      lastUpdated: Date.now(),
    });
    return;
  }
  transcriptStore.mergeEntries(sessionKey, typed, merge ? { merge } : undefined);
}

export function buildTranscriptWsCallbacks(
  options?: TranscriptWsBridgeOptions,
): TranscriptWsCallbacks {
  const merge = options?.merge;
  return {
    onHistoryUpdate: (sessionKey, entries, replace) => {
      handleHistoryUpdate(sessionKey, entries, replace, merge);
    },
  };
}

export function attachTranscriptWsBridge(
  sharedWs: ListenerRegistrar,
  options?: TranscriptWsBridgeOptions,
): () => void {
  return sharedWs.addListener(buildTranscriptWsCallbacks(options));
}
