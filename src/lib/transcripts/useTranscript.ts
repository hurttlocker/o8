'use client';

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  EMPTY_TRANSCRIPT_SLICE,
  transcriptStore,
  type TranscriptSlice,
} from './store';

const getServerSnapshot = (): TranscriptSlice => EMPTY_TRANSCRIPT_SLICE;

type SubscribeToTranscriptSession = (sessionKey: string) => () => void;

const TranscriptSessionSubscriptionContext = createContext<SubscribeToTranscriptSession | null>(null);

export function TranscriptSessionSubscriptionProvider({
  children,
  subscribe,
}: {
  children: ReactNode;
  subscribe: SubscribeToTranscriptSession;
}) {
  return createElement(TranscriptSessionSubscriptionContext.Provider, { value: subscribe }, children);
}

export interface UseTranscriptOptions {
  live?: boolean;
}

export function useTranscript(
  sessionKey: string | null | undefined,
  options?: UseTranscriptOptions,
): TranscriptSlice {
  const subscribeToSession = useContext(TranscriptSessionSubscriptionContext);
  const liveSessionKey = options?.live === false ? null : sessionKey;

  useEffect(() => {
    if (!liveSessionKey || !subscribeToSession) return;
    return subscribeToSession(liveSessionKey);
  }, [liveSessionKey, subscribeToSession]);

  const subscribeToStore = useCallback((listener: () => void) => {
    if (!sessionKey) return () => {};
    return transcriptStore.subscribe(sessionKey, listener);
  }, [sessionKey]);
  const getSnapshot = useCallback(
    () => transcriptStore.getSlice(sessionKey),
    [sessionKey],
  );

  return useSyncExternalStore(
    subscribeToStore,
    getSnapshot,
    getServerSnapshot,
  );
}
