'use client';
import { useEffect, useState } from 'react';
import type { VisualizationReference } from '@/lib/visualizations/types';
import { loadVisualization } from './document-cache';
import { VisualizationFrame } from './VisualizationFrame';

export function VisualizationWorkspace({ id }: { id: string }) {
  const [state, setState] = useState<{ id: string; ref?: VisualizationReference; error?: string }>({ id });
  useEffect(() => {
    let stopped = false;
    void loadVisualization(id).then(ref => { if (!stopped) setState({ id, ref }); })
      .catch(error => { if (!stopped) setState({ id, error: error instanceof Error ? error.message : 'Visualization unavailable.' }); });
    return () => { stopped = true; };
  }, [id]);
  return <div style={{ height: '100%', overflow: 'auto', scrollbarWidth: 'none', padding: 24, minWidth: 0 }}>
    {state.id === id && state.ref ? <VisualizationFrame key={id} reference={state.ref} expanded />
      : <div role="status" style={{ color: 'var(--t-text-muted)', fontSize: 13 }}>{state.id === id && state.error ? state.error : 'Loading visualization…'}</div>}
  </div>;
}
