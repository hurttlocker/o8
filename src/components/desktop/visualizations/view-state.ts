'use client';

import { visualizationState } from '@/lib/visualizations/view-state';

const PREFIX = 'o8:visualization-view:v1:';
export const VISUALIZATION_STATE_EVENT = 'o8:visualization-view-changed';

export function readVisualizationState(id: string): Record<string, unknown> {
  try { return visualizationState(JSON.parse(localStorage.getItem(`${PREFIX}${id}`) ?? '{}')) ?? {}; } catch { return {}; }
}

export function writeVisualizationState(id: string, value: unknown): boolean {
  const state = visualizationState(value);
  if (!state) return false;
  try {
    localStorage.setItem(`${PREFIX}${id}`, JSON.stringify(state));
    window.dispatchEvent(new CustomEvent(VISUALIZATION_STATE_EVENT, { detail: { id, state } }));
    return true;
  } catch { return false; }
}
