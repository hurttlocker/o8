'use client';
import { useEffect, useState } from 'react';
import { isVisualizationReference, type VisualizationReference } from '@/lib/visualizations/types';

export function useVisualizationVersions(reference: VisualizationReference) {
  const rootId = reference.rootId ?? reference.id;
  const [snapshot, setSnapshot] = useState<{ root: string; refs: VisualizationReference[] }>({ root: rootId, refs: [reference] });
  const [chosen, choose] = useState<{ root: string; id: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const refresh = async () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const response = await fetch(`/api/visualizations/${rootId}?versions=1`, { cache: 'no-store', signal: controller.signal });
        const body = await response.json() as { result?: { versions?: unknown[] } };
        if (response.ok && Array.isArray(body.result?.versions) && !controller.signal.aborted) {
          const refs = body.result.versions.filter(isVisualizationReference).filter(ref => (ref.rootId ?? ref.id) === rootId);
          if (refs.length) setSnapshot({ root: rootId, refs });
        }
      } catch { /* Keep the current visual through missed refreshes. */ }
      finally { busy = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [rootId, reference.id]);
  const refs = snapshot.root === rootId ? snapshot.refs : [reference];
  const latest = (refs[0]?.version ?? 1) >= (reference.version ?? 1) ? refs[0] : reference;
  const selected = chosen?.root === rootId ? refs.find(ref => ref.id === chosen.id) : undefined;
  return { reference: selected ?? latest, versions: refs, latest, choose: (id: string) => choose(id ? { root: rootId, id } : null), chosen: selected?.id ?? '' };
}
