'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuntimeCapacityControlSnapshot } from '@/lib/runtime/capacity-service';

export function useRuntimeUsage(active: boolean) {
  const [snapshot, setSnapshot] = useState<RuntimeCapacityControlSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const refresh = useCallback(async (fresh = false) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    try {
      const response = await fetch(`/api/runtime/capacity${fresh ? '?fresh=1' : ''}`, { cache: 'no-store', signal: controller.signal });
      const data = await response.json();
      if (!response.ok || data?.schema !== 'o8/runtime-capacity-control/v1') throw new Error('Usage is temporarily unavailable.');
      if (!controller.signal.aborted) { setSnapshot(data); setError(null); }
    } catch {
      if (!controller.signal.aborted) setError('Could not refresh usage. Previous observations remain visible.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
    return () => { requestRef.current?.abort(); window.clearInterval(timer); };
  }, [active, refresh]);
  return { snapshot, loading, error, refresh };
}
