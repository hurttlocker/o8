import { useCallback, useEffect, useState } from 'react';
import { fetchOnce } from '@/lib/panel/fetch-cache';
import type { AgentSummary } from '@/lib/fleet/types';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import type { TimelineSegment } from './types';

export function useTimelineData() {
  const [segments, setSegments] = useState<TimelineSegment[]>([]);
  const [windowMinutes, setWindowMinutes] = useState(0);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/panel/timeline');
      if (res.ok) {
        const data = await res.json();
        setWindowMinutes(data.windowMinutes ?? 0);
        if (data.segments?.length > 0) {
          setSegments(data.segments);
          try {
            sessionStorage.setItem('cortex-timeline', JSON.stringify({
              ts: Date.now(),
              segments: data.segments,
              windowMinutes: data.windowMinutes ?? 0,
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
    fetchData();
    const handler = () => { fetchData(); };
    const wsEvents = ['o8:agent-lifecycle', 'o8:lane-lifecycle'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = setInterval(fetchData, 300_000);
    return () => {
      clearInterval(fallbackId);
      for (const e of wsEvents) window.removeEventListener(e, handler);
    };
  }, [fetchData]);

  return { segments, windowMinutes, loading };
}

export function useTimelineSessions() {
  const [sessions, setSessions] = useState<AgentSummary[]>([]);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetchOnce('/api/mobile/inbox');
      if (!res.ok) return;
      const data = await res.json() as MobileInboxSnapshot;
      setSessions(data.sessions ?? []);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    void fetchSessions();
    const handler = () => { void fetchSessions(); };
    const wsEvents = ['o8:inbox', 'o8:agent-lifecycle'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = setInterval(fetchSessions, 300_000);
    return () => {
      clearInterval(fallbackId);
      for (const e of wsEvents) window.removeEventListener(e, handler);
    };
  }, [fetchSessions]);

  return sessions;
}
