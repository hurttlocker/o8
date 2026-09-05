import { useCallback, useEffect, useState } from 'react';
import { fetchOnce } from '@/lib/panel/fetch-cache';
import type { AgentSummary } from '@/lib/fleet/types';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import type { TimelineSegment } from './types';

const INITIAL_TIMELINE_LOAD_DELAY_MS = 3_000;

export function useTimelineData() {
  const [segments, setSegments] = useState<TimelineSegment[]>([]);
  const [windowMinutes, setWindowMinutes] = useState(0);
  // Absolute timestamp the route used as minute-zero for every segment's
  // startMin. The strip is rolling 24h so this slides forward each fetch;
  // formatTime needs it to render correct clock times in the hover card.
  const [anchorMs, setAnchorMs] = useState<number>(() => Date.now() - 24 * 60 * 60 * 1000);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/panel/timeline');
      if (res.ok) {
        const data = await res.json();
        setWindowMinutes(data.windowMinutes ?? 0);
        if (typeof data.anchorStartIso === 'string') {
          const parsed = Date.parse(data.anchorStartIso);
          if (Number.isFinite(parsed)) setAnchorMs(parsed);
        }
        if (data.segments?.length > 0) {
          setSegments(data.segments);
          try {
            sessionStorage.setItem('cortex-timeline', JSON.stringify({
              ts: Date.now(),
              segments: data.segments,
              windowMinutes: data.windowMinutes ?? 0,
              anchorStartIso: data.anchorStartIso ?? null,
            }));
          } catch {}
          setLoading(false);
          return;
        }
      }
    } catch {}
    try {
      const cached = sessionStorage.getItem('cortex-timeline');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.ts < 300_000 && parsed.segments?.length > 0) {
          setSegments(parsed.segments);
          setWindowMinutes(parsed.windowMinutes ?? 0);
          if (typeof parsed.anchorStartIso === 'string') {
            const parsedAnchor = Date.parse(parsed.anchorStartIso);
            if (Number.isFinite(parsedAnchor)) setAnchorMs(parsedAnchor);
          }
          setLoading(false);
          return;
        }
      }
    } catch {}
    setSegments([]);
    setWindowMinutes(0);
    setLoading(false);
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => { void fetchData(); }, INITIAL_TIMELINE_LOAD_DELAY_MS);
    const handler = () => { fetchData(); };
    const wsEvents = ['o8:lifecycle-reconcile'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = setInterval(fetchData, 300_000);
    return () => {
      window.clearTimeout(initialLoad);
      clearInterval(fallbackId);
      for (const e of wsEvents) window.removeEventListener(e, handler);
    };
  }, [fetchData]);

  return { segments, windowMinutes, anchorMs, loading };
}

export function useTimelineSessions() {
  const [sessions, setSessions] = useState<AgentSummary[]>([]);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetchOnce('/api/mobile/inbox?workspaceReview=0');
      if (!res.ok) return;
      const data = await res.json() as MobileInboxSnapshot;
      setSessions(data.sessions ?? []);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => { void fetchSessions(); }, INITIAL_TIMELINE_LOAD_DELAY_MS);
    const handler = () => { void fetchSessions(); };
    const wsEvents = ['o8:inbox', 'o8:lifecycle-reconcile'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = setInterval(fetchSessions, 300_000);
    return () => {
      window.clearTimeout(initialLoad);
      clearInterval(fallbackId);
      for (const e of wsEvents) window.removeEventListener(e, handler);
    };
  }, [fetchSessions]);

  return sessions;
}
