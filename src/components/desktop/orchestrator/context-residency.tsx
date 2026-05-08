'use client';

/**
 * Client-side context residency store for the orchestrator.
 *
 * Publishes a live snapshot of the orchestrator transcript + backend
 * running token total so the ContextMeter popover and the message
 * renderer can subscribe without prop-drilling through ThoughtsChatPanel.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

export interface OrchestratorContextResidencyValue {
  /** Live transcript snapshot published by ThoughtsChatPanel. */
  messages: MobileTranscriptEntry[];
  /** True running total (tokens) from the backend telemetry. */
  runningTotal: number;
  /** id of the currently-streaming assistant turn (null when idle). */
  activeAssistantId: string | null;
  /** Publisher used by ThoughtsChatPanel to sync the transcript. */
  publish: (snapshot: {
    messages: MobileTranscriptEntry[];
    runningTotal: number;
    activeAssistantId: string | null;
  }) => void;
}

const OrchestratorContextResidencyContext = createContext<OrchestratorContextResidencyValue | null>(null);

interface OrchestratorContextResidencyProviderProps {
  children: ReactNode;
}

export function OrchestratorContextResidencyProvider({ children }: OrchestratorContextResidencyProviderProps) {
  const [messages, setMessages] = useState<MobileTranscriptEntry[]>([]);
  const [runningTotal, setRunningTotal] = useState(0);
  const [activeAssistantId, setActiveAssistantId] = useState<string | null>(null);

  const publish = useCallback<OrchestratorContextResidencyValue['publish']>((snapshot) => {
    setMessages((prev) => {
      if (prev === snapshot.messages) return prev;
      // Callers commonly pass a fresh `[]` each render in non-orchestrator
      // mode; reference equality alone would re-render forever. Treat
      // same-length + same-last-id as equal — cheap and covers the
      // streaming-append case where only the tail changes.
      if (prev.length === snapshot.messages.length) {
        if (prev.length === 0) return prev;
        if (prev[prev.length - 1]?.id === snapshot.messages[snapshot.messages.length - 1]?.id
          && prev[0]?.id === snapshot.messages[0]?.id) {
          return prev;
        }
      }
      return snapshot.messages;
    });
    setRunningTotal((prev) => (prev === snapshot.runningTotal ? prev : snapshot.runningTotal));
    setActiveAssistantId((prev) => (prev === snapshot.activeAssistantId ? prev : snapshot.activeAssistantId));
  }, []);

  const value = useMemo<OrchestratorContextResidencyValue>(() => ({
    messages,
    runningTotal,
    activeAssistantId,
    publish,
  }), [messages, runningTotal, activeAssistantId, publish]);

  return (
    <OrchestratorContextResidencyContext.Provider value={value}>
      {children}
    </OrchestratorContextResidencyContext.Provider>
  );
}

/** Full residency context. Returns null when no provider is mounted. */
export function useOrchestratorContextResidency(): OrchestratorContextResidencyValue | null {
  return useContext(OrchestratorContextResidencyContext);
}

/**
 * Always returns false. Retained as a noop so DesktopAgentMessage doesn't
 * need to be touched when the eviction UI was retired with the side-panel
 * inspector. Safe to remove once that consumer is updated.
 */
export function useOrchestratorEntryEvicted(_entryId: string): boolean {
  return false;
}
