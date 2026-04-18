'use client';

/**
 * Client-side context residency store for the orchestrator.
 *
 * Tracks which transcript turns the operator has "evicted" or "pinned"
 * from the context inspector. This is UI-layer state only — we do not
 * currently remove evicted turns from the live Claude Code session's
 * backend context window. The inspector's "IN CONTEXT" count reflects
 * the adjusted local view; the ContextMeter pill still shows the true
 * running total from the backend.
 *
 * Mounted at the OrchestratorTab level so the ContextInspector panel
 * and the DesktopAgentMessage renderer (which dims evicted rows) can
 * both subscribe without prop-drilling through ThoughtsChatPanel.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

const INSPECTOR_OPEN_KEY = 'cortex-ide:orchestrator:context-inspector-open';

function readStoredInspectorOpen(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(INSPECTOR_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeStoredInspectorOpen(open: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(INSPECTOR_OPEN_KEY, open ? '1' : '0');
  } catch {
    // ignore quota / privacy mode
  }
}

export interface OrchestratorContextResidencyValue {
  /** Live transcript snapshot published by ThoughtsChatPanel. */
  messages: MobileTranscriptEntry[];
  /** True running total (tokens) from the backend telemetry. */
  runningTotal: number;
  /** id of the currently-streaming assistant turn (null when idle). */
  activeAssistantId: string | null;
  /** Set of entry ids operator has marked evicted from the UI view. */
  evictedIds: ReadonlySet<string>;
  /** Set of entry ids operator has pinned. */
  pinnedIds: ReadonlySet<string>;
  /** Inspector panel visibility. */
  isOpen: boolean;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  /** Mutators used by the inspector. */
  evict: (id: string) => void;
  unevict: (id: string) => void;
  togglePin: (id: string) => void;
  /** Publisher used by ThoughtsChatPanel to sync the transcript. */
  publish: (snapshot: {
    messages: MobileTranscriptEntry[];
    runningTotal: number;
    activeAssistantId: string | null;
  }) => void;
}

const OrchestratorContextResidencyContext = createContext<OrchestratorContextResidencyValue | null>(null);
// Narrow context for evicted ids only. Split out so the hot transcript
// renderer (DesktopAgentMessage) only re-renders when the evicted set
// flips, not on every streaming token that updates `messages`.
const OrchestratorEvictedContext = createContext<ReadonlySet<string> | null>(null);

interface OrchestratorContextResidencyProviderProps {
  children: ReactNode;
}

export function OrchestratorContextResidencyProvider({ children }: OrchestratorContextResidencyProviderProps) {
  const [messages, setMessages] = useState<MobileTranscriptEntry[]>([]);
  const [runningTotal, setRunningTotal] = useState(0);
  const [activeAssistantId, setActiveAssistantId] = useState<string | null>(null);
  const [evictedIds, setEvictedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [isOpen, setIsOpen] = useState<boolean>(() => readStoredInspectorOpen());

  useEffect(() => {
    writeStoredInspectorOpen(isOpen);
  }, [isOpen]);

  const publish = useCallback<OrchestratorContextResidencyValue['publish']>((snapshot) => {
    setMessages((prev) => (prev === snapshot.messages ? prev : snapshot.messages));
    setRunningTotal((prev) => (prev === snapshot.runningTotal ? prev : snapshot.runningTotal));
    setActiveAssistantId((prev) => (prev === snapshot.activeAssistantId ? prev : snapshot.activeAssistantId));
  }, []);

  const evict = useCallback((id: string) => {
    setEvictedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const unevict = useCallback((id: string) => {
    setEvictedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const togglePin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setOpen = useCallback((open: boolean) => {
    setIsOpen(open);
  }, []);

  const toggleOpen = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  const value = useMemo<OrchestratorContextResidencyValue>(() => ({
    messages,
    runningTotal,
    activeAssistantId,
    evictedIds,
    pinnedIds,
    isOpen,
    setOpen,
    toggleOpen,
    evict,
    unevict,
    togglePin,
    publish,
  }), [messages, runningTotal, activeAssistantId, evictedIds, pinnedIds, isOpen, setOpen, toggleOpen, evict, unevict, togglePin, publish]);

  return (
    <OrchestratorContextResidencyContext.Provider value={value}>
      <OrchestratorEvictedContext.Provider value={evictedIds}>
        {children}
      </OrchestratorEvictedContext.Provider>
    </OrchestratorContextResidencyContext.Provider>
  );
}

/** Full residency context. Returns null when no provider is mounted. */
export function useOrchestratorContextResidency(): OrchestratorContextResidencyValue | null {
  return useContext(OrchestratorContextResidencyContext);
}

/**
 * Narrow helper — returns true when this entry is in the evicted set.
 * Subscribes to OrchestratorEvictedContext only, so streaming message
 * updates (which bump the full residency value every token) don't
 * trigger a re-render of every message component in the transcript.
 */
export function useOrchestratorEntryEvicted(entryId: string): boolean {
  const evictedIds = useContext(OrchestratorEvictedContext);
  if (!evictedIds) return false;
  return evictedIds.has(entryId);
}
