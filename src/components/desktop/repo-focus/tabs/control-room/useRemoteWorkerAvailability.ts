'use client';

import { useEffect, useState } from 'react';

export function useRemoteWorkerAvailability() {
  const [status, setStatus] = useState<{ available: boolean; connectedWorkers: number; detail: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch('/api/tasks/worker-availability', { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('Unable to check remote workers.');
        const payload = await response.json();
        if (!controller.signal.aborted) setStatus(payload);
      } catch {
        if (!controller.signal.aborted) setStatus({ available: false, connectedWorkers: 0, detail: 'Unable to check remote workers. Dispatch will recheck the connection.' });
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 10_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  return status;
}
