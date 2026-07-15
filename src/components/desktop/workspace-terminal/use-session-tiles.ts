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
  collectThreadLeaves,
  createDefaultSessionTileLayout,
  deserializeSessionTileLayout,
  hasAnyAuxLeaf,
  pruneStaleSessions,
  replaceLeafWithThread,
  resizeSessionSplit,
  serializeSessionTileLayout,
  splitChatWithSession,
  splitLeafWithThread,
  splitSessionWithSession,
  type SessionTileLayout,
  type SessionTileSplitDirection,
  type ThreadPanePayload,
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

const SESSION_TILE_KEY_PREFIX = 'o8:orchestrator:session-tiles:tab:';

/** Remove the persisted session-tile layout for a single tab. Call on tab
 *  close so a closed orchestrator tab never leaves an orphaned localStorage
 *  key behind (the leak that piled up 80+ dead `…:session-tiles:tab:*` keys). */
export function clearSessionTileStorage(tabId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(sessionTileStorageKey(tabId));
  } catch {
    // ignore
  }
}

/** One-time scrub: drop every session-tile key whose tab id is not in
 *  `validTabIds`. Pre-fix these keys were never cleaned on close, so they
 *  accumulated forever. Returns the number of orphans removed. */
export function scrubOrphanSessionTileKeys(validTabIds: Set<string>): number {
  if (typeof window === 'undefined') return 0;
  let removed = 0;
  try {
    const orphans: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(SESSION_TILE_KEY_PREFIX)) continue;
      const tabId = key.slice(SESSION_TILE_KEY_PREFIX.length);
      if (!validTabIds.has(tabId)) orphans.push(key);
    }
    for (const key of orphans) {
      window.localStorage.removeItem(key);
      removed += 1;
    }
  } catch {
    // ignore
  }
  return removed;
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
  /** Drag-to-split: add a thread pane by splitting the target leaf. */
  splitLeafWithThreadPane: (
    targetLeafId: string,
    thread: ThreadPanePayload,
    direction: SessionTileSplitDirection,
  ) => void;
  /** Drag-to-replace: swap the target leaf's content for a thread pane. */
  replaceLeafWithThreadPane: (targetLeafId: string, thread: ThreadPanePayload) => void;
  /** Close any thread pane bound to this thread (main chat claimed it). */
  pruneThreadPane: (threadId: string) => void;
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
  const threadLeaves = useMemo(() => collectThreadLeaves(layout.root), [layout.root]);
  // Tiled = anything beyond the bare chat: session transcripts OR thread
  // panes (drag-to-split). Both need the SessionTileSurface mounted.
  const isTiled = tiledSessions.length > 0 || threadLeaves.length > 0;

  // Persist whenever the layout changes — but NOT the default/empty layout.
  // Pre-fix (2026-06-22) every orchestrator tab wrote a `…:session-tiles:tab:*`
  // key on mount even when empty (no tiled sessions); fresh-UUID tab ids per
  // spawn + restore-drop paths that never route through close then orphaned
  // those keys forever (the 10+/80+ dead keys piling up). Now an empty layout
  // writes nothing and clears any stale prior key.
  useEffect(() => {
    if (!hasAnyAuxLeaf(layout)) {
      clearSessionTileStorage(tabId);
      return;
    }
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
      // Default/auto split stacks horizontally (under the chat), matching the
      // terminal split. The explicit pill menu still offers "split right"
      // (vertical) for users who want a column. (#1285)
      return splitChatWithSession(current, sessionKey, 'horizontal');
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

  const splitLeafWithThreadPane = useCallback((
    targetLeafId: string,
    thread: ThreadPanePayload,
    direction: SessionTileSplitDirection,
  ) => {
    setLayout((current) => splitLeafWithThread(current, targetLeafId, thread, direction));
  }, []);

  const replaceLeafWithThreadPane = useCallback((
    targetLeafId: string,
    thread: ThreadPanePayload,
  ) => {
    setLayout((current) => replaceLeafWithThread(current, targetLeafId, thread));
  }, []);

  const pruneThreadPane = useCallback((threadId: string) => {
    setLayout((current) => {
      const dup = collectThreadLeaves(current.root).find((leaf) => leaf.threadId === threadId);
      return dup ? closeSessionLeaf(current, dup.id) : current;
    });
  }, []);

  const autoTileSessions = useCallback((sessionKeys: string[]) => {
    if (sessionKeys.length === 0) return;
    setLayout((current) => {
      let next = current;
      for (let index = 0; index < sessionKeys.length; index += 1) {
        const key = sessionKeys[index]!;
        if (index === 0) {
          next = splitChatWithSession(next, key, 'horizontal');
        } else {
          const previousLeaf = collectSessionLeaves(next.root)
            .find((leaf) => leaf.sessionKey === sessionKeys[index - 1]);
          if (previousLeaf) {
            next = splitSessionWithSession(next, previousLeaf.id, key, 'horizontal');
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
    splitLeafWithThreadPane,
    replaceLeafWithThreadPane,
    pruneThreadPane,
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
