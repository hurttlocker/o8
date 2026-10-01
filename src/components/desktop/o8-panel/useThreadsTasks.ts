'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ipcFetch } from '@/lib/tauri/ipc-fetch';
import type { TaskPoolPayload, TaskPoolTask } from '../repo-focus/tabs/control-room/types';

export function useThreadsTasks(active: boolean, scopeKey: string) {
  const [snapshot, setSnapshot] = useState<{ scopeKey: string; tasks: TaskPoolTask[]; evidenceRevision: number } | null>(null);
  const [status, setStatus] = useState<{ scopeKey: string; loading: boolean; error: string | null } | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const generation = useRef(0);
  const evidenceRevision = useRef(0);

  useEffect(() => {
    if (!active) return;
    const current = ++generation.current;
    const controller = new AbortController();
    let inFlight = false;
    const load = async () => {
      if (inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      setStatus({ scopeKey, loading: true, error: null });
      try {
        const response = await ipcFetch('/api/tasks?includeBrief=false&includeDone=true', { cache: 'no-store', signal: controller.signal });
        const payload = await response.json() as TaskPoolPayload & { error?: string };
        if (!response.ok) throw new Error(payload.error || 'Unable to load threads.');
        if (!controller.signal.aborted && generation.current === current) {
          setSnapshot({ scopeKey, tasks: payload.tasks ?? [], evidenceRevision: ++evidenceRevision.current });
          setStatus({ scopeKey, loading: false, error: null });
        }
      } catch (err) {
        if (!controller.signal.aborted && generation.current === current) setStatus({ scopeKey, loading: false, error: err instanceof Error ? err.message : 'Unable to load threads.' });
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 7000);
    document.addEventListener('visibilitychange', load);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [active, scopeKey, revision]);

  return { tasks: snapshot?.scopeKey === scopeKey ? snapshot.tasks : [], evidenceRevision: snapshot?.evidenceRevision ?? 0, loading: active && (status?.scopeKey !== scopeKey || status.loading), error: status?.scopeKey === scopeKey ? status.error : null, refresh };
}
