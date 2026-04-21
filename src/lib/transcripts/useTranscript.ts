'use client';

import { useSyncExternalStore } from 'react';
import {
  EMPTY_TRANSCRIPT_SLICE,
  transcriptStore,
  type TranscriptSlice,
} from './store';

const getServerSnapshot = (): TranscriptSlice => EMPTY_TRANSCRIPT_SLICE;

export function useTranscript(sessionKey: string | null | undefined): TranscriptSlice {
  return useSyncExternalStore(
    (listener) => {
      if (!sessionKey) return () => {};
      return transcriptStore.subscribe(sessionKey, listener);
    },
    () => transcriptStore.getSlice(sessionKey),
    getServerSnapshot,
  );
}
