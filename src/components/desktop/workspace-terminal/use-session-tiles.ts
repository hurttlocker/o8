'use client';

/**
 * useSessionTiles — orchestrator session tile state + handlers (issue #663).
 *
 * Encapsulates the SessionTileLayout state, persistence, focus pointer,
 * pill context menu state, and the split/close/resize/clear callbacks so
 * OrchestratorTab.tsx stays under the 800-line ceiling.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  SessionPillContextMenuItem,
} from '@/components/desktop/SessionPillContextMenu';
import type {
  SessionPillContextMenuRequest,
} from '@/components/desktop/SessionVisualizer';
import {
  addSessionToLayout,
  clearSessionTiles,
  closeSessionLeaf,
  collectSessionKeysByArrival,
  collectSessionLeaves,
  collectThreadLeaves,
  createDefaultSessionTileLayout,
  deserializeSessionTileLayout,
  hasAnyAuxLeaf,
  replaceLeafWithThread,
  reconcileSessionTileParticipants,
  resizeSessionSplit,
  serializeSessionTileLayout,
  splitChatWithSession,
  splitLeafWithThread,
  splitSessionWithSession,
  type SessionTileLayout,
  type SessionTileSplitDirection,
  type ThreadPanePayload,
} from '@/lib/orchestrator/session-tiles';
import type { WorkerParticipant } from '@/lib/orchestrator/participant-projection';
import {
  claimOutsideWorkerSplits,
  outsideWorkerSessionKeysForLane,
  releaseOutsideWorkerSplits,
  removeOutsideWorkerSplits,
  subscribeOutsideWorkerSplits,
} from '@/lib/orchestrator/outside-worker-split';

const EMPTY_RETIRED_SESSION_KEYS = new Set<string>();

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
  repoPath: string;
  workspaceId?: string;
  threadId?: string | null;
  active?: boolean;
  /** sessionKeys of every active fleet agent — used to prune stale leaves. */
  liveSessionKeys: string[];
  /** Session keys whose governed lane has completed or archived. */
  retiredSessionKeys?: ReadonlySet<string>;
  participants?: ReadonlyArray<WorkerParticipant>;
}

export interface UseSessionTilesReturn {
  layout: SessionTileLayout;
  setLayout: React.Dispatch<React.SetStateAction<SessionTileLayout>>;
  tiledSessions: string[];
  isTiled: boolean;
  sessionLeaves: ReturnType<typeof collectSessionLeaves>;
  focusedSessionKey: string | null;
  setFocusedSessionKey: (sessionKey: string | null) => void;
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

export function resolveFocusedSessionKey(
  sessionLeaves: ReturnType<typeof collectSessionLeaves>,
  focusedLeafIdentity: string | null,
): string | null {
  if (!focusedLeafIdentity) return null;
  return sessionLeaves.find((leaf) => (
    leaf.id === focusedLeafIdentity || leaf.sessionKey === focusedLeafIdentity
  ))?.sessionKey ?? null;
}

export const OUTSIDE_WORKER_HOST_EMPTY_EVENT = 'o8:outside-worker-host-empty';

export function useSessionTiles({
  tabId,
  repoPath,
  workspaceId,
  threadId,
  liveSessionKeys,
  retiredSessionKeys = EMPTY_RETIRED_SESSION_KEYS,
  participants = [],
  active = false,
}: UseSessionTilesArgs): UseSessionTilesReturn {
  const [layout, setLayout] = useState<SessionTileLayout>(
    () => readStoredSessionTileLayout(tabId),
  );
  const [focusedLeafIdentity, setFocusedLeafIdentity] = useState<string | null>(null);
  const [pillContextMenu, setPillContextMenu] = useState<{
    request: SessionPillContextMenuRequest;
  } | null>(null);
  const [outsideWorkerSessionKeys, setOutsideWorkerSessionKeys] = useState<string[]>([]);

  const participantTransports = useMemo(() => participants.flatMap((participant) => (
    participant.sessionKey ? [{
      participantId: participant.id,
      packetId: participant.packetId,
      laneId: participant.laneId,
      sessionKey: participant.sessionKey,
      repoPath: participant.repoPath,
      runtime: participant.runtime,
      taskSummary: participant.taskSummary,
      launchContext: participant.launchContext,
    }] : []
  )), [participants]);

  const tiledSessions = useMemo(() => collectSessionKeysByArrival(layout.root), [layout.root]);
  const sessionLeaves = useMemo(() => collectSessionLeaves(layout.root), [layout.root]);
  const hadSessionLeafRef = useRef(sessionLeaves.length > 0);
  const focusedLeaf = useMemo(() => sessionLeaves.find((leaf) => (
    leaf.id === focusedLeafIdentity || leaf.sessionKey === focusedLeafIdentity
  )) ?? null, [focusedLeafIdentity, sessionLeaves]);
  const focusedSessionKey = resolveFocusedSessionKey(sessionLeaves, focusedLeafIdentity);
  const setFocusedSessionKey = useCallback((sessionKey: string | null) => {
    if (!sessionKey) {
      setFocusedLeafIdentity(null);
      return;
    }
    const leaf = sessionLeaves.find((candidate) => candidate.sessionKey === sessionKey);
    setFocusedLeafIdentity(leaf?.id ?? sessionKey);
  }, [sessionLeaves]);
  const threadLeaves = useMemo(() => collectThreadLeaves(layout.root), [layout.root]);
  // Tiled = anything beyond the bare chat: session transcripts OR thread
  // panes (drag-to-split). Both need the SessionTileSurface mounted.
  const isTiled = tiledSessions.length > 0 || threadLeaves.length > 0;

  useEffect(() => {
    if (sessionLeaves.length > 0) {
      hadSessionLeafRef.current = true;
      return;
    }
    if (!hadSessionLeafRef.current || threadLeaves.length > 0) return;
    hadSessionLeafRef.current = false;
    window.dispatchEvent(new CustomEvent(OUTSIDE_WORKER_HOST_EMPTY_EVENT, {
      detail: { tabId },
    }));
  }, [sessionLeaves.length, tabId, threadLeaves.length]);

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

  useEffect(() => {
    if (participantTransports.length === 0) return;
    const handle = window.setTimeout(() => {
      setLayout((current) => reconcileSessionTileParticipants(current, participantTransports));
    }, 0);
    return () => window.clearTimeout(handle);
  }, [layout.root, participantTransports]);

  // Outside-launched workers claim the active orchestrator tab and enter
  // through this same session tree. That preserves the drag-to-split FLIP
  // motion, divider, resize, and close behavior without a dashboard tile.
  useEffect(() => {
    if (!active || !workspaceId) return undefined;
    const claim = () => {
      const requests = claimOutsideWorkerSplits({
        tabId,
        repoPath,
        workspaceId,
        threadId,
      });
      if (requests.length === 0) return;
      setOutsideWorkerSessionKeys((current) => {
        const next = new Set(current);
        for (const request of requests) next.add(request.sessionKey);
        return next.size === current.length ? current : [...next];
      });
      setLayout((current) => {
        let next = current;
        for (const request of requests) {
          const transport = {
            participantId: request.packetId?.trim() || request.laneId?.trim() || request.sessionKey,
            packetId: request.packetId,
            laneId: request.laneId,
            sessionKey: request.sessionKey,
            repoPath: request.repoPath,
            runtime: request.runtime,
            taskSummary: request.title,
            launchContext: request.launchContext,
          };
          next = reconcileSessionTileParticipants(next, [transport]);
          next = addSessionToLayout(next, request.sessionKey);
          next = reconcileSessionTileParticipants(next, [transport]);
        }
        return next;
      });
    };
    claim();
    const unsubscribe = subscribeOutsideWorkerSplits(claim);
    return unsubscribe;
  }, [active, repoPath, tabId, threadId, workspaceId]);

  // A tab keeps ownership while it is merely in the background. Releasing on
  // every active-tab switch makes the broker remount and refocus that tab,
  // which prevents two outside workers in different repos from coexisting.
  // The durable claim returns to the broker only when the tab actually leaves
  // the workspace tree.
  useEffect(() => () => releaseOutsideWorkerSplits(tabId), [tabId]);

  // The launch bridge pins a session only across the inventory-arrival race.
  // Once the normal fleet record exists, the existing stale-session pruner
  // owns its lifecycle and removes the pane when that worker disappears.
  useEffect(() => {
    if (outsideWorkerSessionKeys.length === 0) return undefined;
    const known = new Set(liveSessionKeys);
    const handle = window.setTimeout(() => {
      setOutsideWorkerSessionKeys((current) => current.filter((key) => (
        !known.has(key) && !retiredSessionKeys.has(key)
      )));
    }, 0);
    return () => window.clearTimeout(handle);
  }, [liveSessionKeys, outsideWorkerSessionKeys.length, retiredSessionKeys]);

  // Lane retirement is the immediate close path. It covers completed and
  // archived workers even if the fleet inventory is slow to drop the row.
  useEffect(() => {
    const retire = (event: Event) => {
      const detail = (event as CustomEvent<{ data?: { laneId?: string | null; sessionKey?: string | null; status?: string; laneStatus?: string } }>).detail;
      const data = detail?.data;
      const status = data?.laneStatus ?? data?.status;
      if (status !== 'completed' && status !== 'archived') return;
      const laneKeys = data?.laneId ? outsideWorkerSessionKeysForLane(data.laneId) : [];
      const retiredKeys = new Set([
        ...(data?.sessionKey ? [data.sessionKey] : []),
        ...(!data?.sessionKey ? laneKeys : []),
      ]);
      if (retiredKeys.size === 0) return;
      removeOutsideWorkerSplits(retiredKeys);
      setOutsideWorkerSessionKeys((current) => current.filter((key) => !retiredKeys.has(key)));
      setLayout((current) => {
        let next = current;
        for (const leaf of collectSessionLeaves(current.root)) {
          if (leaf.sessionKey && retiredKeys.has(leaf.sessionKey)) next = closeSessionLeaf(next, leaf.id);
        }
        return next;
      });
    };
    window.addEventListener('o8:lane-lifecycle', retire as EventListener);
    return () => window.removeEventListener('o8:lane-lifecycle', retire as EventListener);
  }, []);

  // Inventory disappearance is not completion evidence. A runtime can rotate
  // or briefly drop its fleet row while the durable lane is still live, so
  // retire only keys confirmed by the completed/archived lane view. The
  // transcript store is deliberately left intact for the archive surface.
  useEffect(() => {
    if (retiredSessionKeys.size === 0) return undefined;
    removeOutsideWorkerSplits(retiredSessionKeys);
    const handle = window.setTimeout(() => {
      setOutsideWorkerSessionKeys((current) => current.filter((key) => !retiredSessionKeys.has(key)));
      setLayout((current) => {
        let next = current;
        for (const leaf of collectSessionLeaves(current.root)) {
          if (leaf.sessionKey && retiredSessionKeys.has(leaf.sessionKey)) {
            next = closeSessionLeaf(next, leaf.id);
          }
        }
        return next;
      });
    }, 0);
    return () => window.clearTimeout(handle);
  }, [retiredSessionKeys]);

  // Stabilize focus on the durable leaf id. A session transport can rotate
  // underneath that leaf without moving focus to the first worker.
  useEffect(() => {
    if (focusedLeaf && focusedLeafIdentity !== focusedLeaf.id) {
      const handle = window.setTimeout(() => setFocusedLeafIdentity(focusedLeaf.id), 0);
      return () => window.clearTimeout(handle);
    }
    if (!focusedLeafIdentity || focusedLeaf) return undefined;
    const handle = window.setTimeout(() => {
      setFocusedLeafIdentity(sessionLeaves[0]?.id ?? null);
    }, 0);
    return () => window.clearTimeout(handle);
  }, [focusedLeaf, focusedLeafIdentity, sessionLeaves]);

  const closeSessionLeafById = useCallback((leafId: string) => {
    const sessionKey = sessionLeaves.find((leaf) => leaf.id === leafId)?.sessionKey;
    if (sessionKey) removeOutsideWorkerSplits([sessionKey]);
    setLayout((current) => closeSessionLeaf(current, leafId));
  }, [sessionLeaves]);

  const toggleTileSession = useCallback((sessionKey: string) => {
    if (tiledSessions.includes(sessionKey)) removeOutsideWorkerSplits([sessionKey]);
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
  }, [tiledSessions]);

  const clearAllTiles = useCallback(() => {
    removeOutsideWorkerSplits(tiledSessions);
    setLayout((current) => clearSessionTiles(current));
  }, [tiledSessions]);

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
  }, [setFocusedSessionKey]);

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
