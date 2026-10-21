'use client';
import { useEffect } from 'react';
import type { CanvasTab } from '@/components/desktop/Canvas';
import { isVisualizationReference } from '@/lib/visualizations/types';

export function useVisualizationWorkspaceEvents(openTab: (tab: CanvasTab) => unknown) {
  useEffect(() => {
    const open = (event: Event) => {
      const ref = (event as CustomEvent<unknown>).detail;
      if (!isVisualizationReference(ref)) return;
      openTab({ id: `visualization:${ref.id}`, kind: 'visualization', label: ref.title, resourceId: ref.id });
    };
    window.addEventListener('o8:open-visualization', open);
    return () => window.removeEventListener('o8:open-visualization', open);
  }, [openTab]);
}
