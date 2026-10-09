'use client';
import { useEffect, useState } from 'react';

export interface UsageMachine { id: string; label: string; local: boolean; enabled: boolean }
export function useUsageMachines(active: boolean) {
  const [machines, setMachines] = useState<UsageMachine[]>([{ id: 'local', label: 'This machine', local: true, enabled: true }]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void fetch('/api/runtime/usage?machines=1', { cache: 'no-store', signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (!response.ok || data.schema !== 'o8/usage-machines/v1' || !Array.isArray(data.machines)) throw new Error('Machine list unavailable');
      if (!controller.signal.aborted) { setMachines(data.machines); setError(null); }
    }).catch(() => { if (!controller.signal.aborted) setError('Saved machines could not be listed. Local history remains available.'); });
    return () => controller.abort();
  }, [active]);
  return { machines, error };
}
