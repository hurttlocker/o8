'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface LaneRecord {
  id: string;
  sessionKey: string | null;
  packetId: string | null;
  status: string;
}

export interface ArchivedLaneView {
  sessionKeys: Set<string>;
  packetIds: Set<string>;
}

// Fetches all lanes and exposes the sessionKeys + packetIds that belong to
// lanes in `archived` status. Subscribes to the realtime lane lifecycle
// window event so a refetch fires whenever a lane transitions.
//
// Used by the sidebar to hide session cards and orchestrator packet chips
// whose lanes have been retired — packet dispatches that shipped, manual
// launches whose branches merged into base, and reaper-cleaned orphans.
export function useLaneArchivedView(): ArchivedLaneView {
  const [state, setState] = useState<ArchivedLaneView>(() => ({
    sessionKeys: new Set<string>(),
    packetIds: new Set<string>(),
  }));
  const inflightRef = useRef(false);

  const fetchOnce = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      const response = await fetch('/api/lanes?active=false', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json() as { lanes?: LaneRecord[] };
      const nextSessions = new Set<string>();
      const nextPackets = new Set<string>();
      for (const lane of data.lanes ?? []) {
        if (lane.status !== 'archived') continue;
        if (lane.sessionKey) nextSessions.add(lane.sessionKey);
        if (lane.packetId) nextPackets.add(lane.packetId);
      }
      setState((current) => {
        const sessionsSame = current.sessionKeys.size === nextSessions.size
          && [...nextSessions].every((key) => current.sessionKeys.has(key));
        const packetsSame = current.packetIds.size === nextPackets.size
          && [...nextPackets].every((id) => current.packetIds.has(id));
        return sessionsSame && packetsSame
          ? current
          : { sessionKeys: nextSessions, packetIds: nextPackets };
      });
    } catch {
      // Lane derivation is best-effort — on fetch failure we keep the last
      // known view and let the next realtime event or retry reconcile.
    } finally {
      inflightRef.current = false;
    }
  }, []);

  useEffect(() => {
    void fetchOnce();
    const handler = () => { void fetchOnce(); };
    window.addEventListener('o8:lane-lifecycle', handler);
    return () => window.removeEventListener('o8:lane-lifecycle', handler);
  }, [fetchOnce]);

  return state;
}

// Backwards-compatible shim while callers migrate to useLaneArchivedView.
export function useLaneArchivedSet(): Set<string> {
  const view = useLaneArchivedView();
  return useMemo(() => view.sessionKeys, [view.sessionKeys]);
}
