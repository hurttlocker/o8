'use client';

/**
 * useSessionTiles — orchestrator session tile state + handlers (issue #663).
 *
 * Encapsulates the SessionTileLayout state, persistence, focus pointer,
 * pill context menu state, and the split/close/resize/clear callbacks so
 * OrchestratorTab.tsx stays under the 800-line ceiling.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  SessionPillContextMenuItem,
} from '@/components/desktop/SessionPillContextMenu';
import type {
  SessionPillContextMenuRequest,
} from '@/components/desktop/SessionVisualizer';
import {
  clearSessionTiles,
  closeSessionLeaf,
  collectSessionKeys,
  collectSessionLeaves,
  createDefaultSessionTileLayout,
  deserializeSessionTileLayout,
  pruneStaleSessions,
  resizeSessionSplit,
  serializeSessionTileLayout,
  splitChatWithSession,
  splitSessionWithSession,
  type SessionTileLayout,
} from '@/lib/orchestrator/session-tiles';

function sessionTileStorageKey(tabId: string): string {
  return `o8:orchestrator:session-tiles:tab:${tabId}`;
}

function readStoredSessionTileLayout(tabId: string): SessionTileLayout {
  if (typeof window === 'undefined') return createDefaultSessionTileLayout();
  try {
    const raw = window.localStorage.getItem(sessionTileStorageKey(tabId));
    return deserializeSessionTileLayout(raw) ?? createDefaultSessionTileLayout();
  } catch {
    return createDefaultSessionTileLayout();
  }
}

function persistSessionTileLayout(tabId: string, layout: SessionTileLayout): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(sessionTileStorageKey(tabId), serializeSessionTileLayout(layout));
  } catch {
    // ignore
  }
}

interface UseSessionTilesArgs {
  tabId: string;
  /** sessionKeys of every active fleet agent — used to prune stale leaves. */
  liveSessionKeys: string[];
}

export interface UseSessionTilesReturn {
  layout: SessionTileLayout;
  setLayout: React.Dispatch<React.SetStateAction<SessionTileLayout>>;
  tiledSessions: string[];
  isTiled: boolean;
  sessionLeaves: ReturnType<typeof collectSessionLeaves>;
  focusedSessionKey: string | null;
  setFocusedSessionKey: React.Dispatch<React.SetStateAction<string | null>>;
  pillContextMenu: { request: SessionPillContextMenuRequest } | null;
  closeSessionLeafById: (leafId: string) => void;
  toggleTileSession: (sessionKey: string) => void;
  clearAllTiles: () => void;
  resizeSplit: (splitId: string, ratio: number) => void;
  requestPillContextMenu: (request: SessionPillContextMenuRequest) => void;
  closePillContextMenu: () => void;
  splitSessionFromMenu: (sessionKey: string, direction: 'horizontal' | 'vertical') => void;
  /** Auto-tile N sessions side-by-side (Best-of-N comparison group). */
  autoTileSessions: (sessionKeys: string[]) => void;
}

export function useSessionTiles({ tabId, liveSessionKeys }: UseSessionTilesArgs): UseSessionTilesReturn {
  const [layout, setLayout] = useState<SessionTileLayout>(
    () => readStoredSessionTileLayout(tabId),
  );
  const [focusedSessionKey, setFocusedSessionKey] = useState<string | null>(null);
  const [pillContextMenu, setPillContextMenu] = useState<{
    request: SessionPillContextMenuRequest;
  } | null>(null);

  const tiledSessions = useMemo(() => collectSessionKeys(layout.root), [layout.root]);
  const sessionLeaves = useMemo(() => collectSessionLeaves(layout.root), [layout.root]);
  const isTiled = tiledSessions.length > 0;

  // Persist whenever the layout changes.
  useEffect(() => {
    persistSessionTileLayout(tabId, layout);
  }, [tabId, layout]);

  // Drop session leaves whose underlying agent has gone away. Defer to a
  // microtask so the prune doesn't trip the synchronous-setState lint rule
  // and so React batches it with any other commit-time updates.
  useEffect(() => {
    const liveSet = new Set(liveSessionKeys);
    const handle = window.setTimeout(() => {
      setLayout((current) => {
        const next = pruneStaleSessions(current, liveSet);
        return next === current ? current : next;
      });
    }, 0);
    return () => window.clearTimeout(handle);
  }, [liveSessionKeys]);

  // Keep focused-session pointer valid as the tree changes.
  useEffect(() => {
    if (!focusedSessionKey) return;
    if (tiledSessions.includes(focusedSessionKey)) return;
    const handle = window.setTimeout(() => {
      setFocusedSessionKey(tiledSessions[0] ?? null);
    }, 0);
    return () => window.clearTimeout(handle);
  }, [focusedSessionKey, tiledSessions]);

  const closeSessionLeafById = useCallback((leafId: string) => {
    setLayout((current) => closeSessionLeaf(current, leafId));
  }, []);

  const toggleTileSession = useCallback((sessionKey: string) => {
    setLayout((current) => {
      const existing = collectSessionLeaves(current.root)
        .find((leaf) => leaf.sessionKey === sessionKey);
      if (existing) {
        return closeSessionLeaf(current, existing.id);
      }
      return splitChatWithSession(current, sessionKey, 'vertical');
    });
  }, []);

  const clearAllTiles = useCallback(() => {
    setLayout((current) => clearSessionTiles(current));
  }, []);

  const resizeSplit = useCallback((splitId: string, ratio: number) => {
    setLayout((current) => resizeSessionSplit(current, splitId, ratio));
  }, []);

  const requestPillContextMenu = useCallback((request: SessionPillContextMenuRequest) => {
    setPillContextMenu({ request });
  }, []);

  const closePillContextMenu = useCallback(() => {
    setPillContextMenu(null);
  }, []);

  const splitSessionFromMenu = useCallback((
    sessionKey: string,
    direction: 'horizontal' | 'vertical',
  ) => {
    setLayout((current) => {
      // No duplicate tiles — abort if the session is already in the tree.
      if (collectSessionLeaves(current.root).some((leaf) => leaf.sessionKey === sessionKey)) {
        return current;
      }
      const existingLeaves = collectSessionLeaves(current.root);
      if (existingLeaves.length === 0) {
        return splitChatWithSession(current, sessionKey, direction);
      }
      const lastLeaf = existingLeaves[existingLeaves.length - 1]!;
      return splitSessionWithSession(current, lastLeaf.id, sessionKey, direction);
    });
    setFocusedSessionKey(sessionKey);
  }, []);

  const autoTileSessions = useCallback((sessionKeys: string[]) => {
    if (sessionKeys.length === 0) return;
    setLayout((current) => {
      let next = current;
      for (let index = 0; index < sessionKeys.length; index += 1) {
        const key = sessionKeys[index]!;
        if (index === 0) {
          next = splitChatWithSession(next, key, 'vertical');
        } else {
          const previousLeaf = collectSessionLeaves(next.root)
            .find((leaf) => leaf.sessionKey === sessionKeys[index - 1]);
          if (previousLeaf) {
            next = splitSessionWithSession(next, previousLeaf.id, key, 'vertical');
          }
        }
      }
      return next;
    });
  }, []);

  return {
    layout,
    setLayout,
    tiledSessions,
    isTiled,
    sessionLeaves,
    focusedSessionKey,
    setFocusedSessionKey,
    pillContextMenu,
    closeSessionLeafById,
    toggleTileSession,
    clearAllTiles,
    resizeSplit,
    requestPillContextMenu,
    closePillContextMenu,
    splitSessionFromMenu,
    autoTileSessions,
  };
}

export function buildPillContextMenuItems(
  request: SessionPillContextMenuRequest,
  sessionLeaves: ReturnType<typeof collectSessionLeaves>,
  onSplitSession: (sessionKey: string, direction: 'horizontal' | 'vertical') => void,
  onCloseLeaf: (leafId: string) => void,
): SessionPillContextMenuItem[] {
  const existingLeaf = sessionLeaves.find((leaf) => leaf.sessionKey === request.sessionKey) ?? null;
  if (existingLeaf) {
    return [
      {
        id: 'close-tile',
        label: 'Close split',
        description: `Hide ${request.sessionName} from the workspace`,
        iconDirection: 'vertical',
        onSelect: () => onCloseLeaf(existingLeaf.id),
      },
    ];
  }
  return [
    {
      id: 'split-right',
      label: 'Open in split right',
      description: 'Place transcript beside the chat',
      iconDirection: 'vertical',
      onSelect: () => onSplitSession(request.sessionKey, 'vertical'),
    },
    {
      id: 'split-below',
      label: 'Open in split below',
      description: 'Stack transcript under the chat',
      iconDirection: 'horizontal',
      onSelect: () => onSplitSession(request.sessionKey, 'horizontal'),
    },
  ];
}
