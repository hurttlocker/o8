'use client';

import { useState } from 'react';
import { HeaderIconPill } from './HeaderIconPill';

export interface TabVisitHistory { ids: string[]; index: number }
export function visitTab(history: TabVisitHistory, id: string): TabVisitHistory {
  if (history.ids[history.index] === id) return history;
  const ids = [...history.ids.slice(0, history.index + 1), id].slice(-100);
  return { ids, index: ids.length - 1 };
}
export function adjacentVisit(history: TabVisitHistory, direction: -1 | 1, openIds: Set<string>): number | null {
  for (let index = history.index + direction; index >= 0 && index < history.ids.length; index += direction) {
    if (history.ids[index] !== history.ids[history.index] && openIds.has(history.ids[index])) return index;
  }
  return null;
}
/** Back/forward follows visits to open tabs in this workspace, skipping closed tabs. */
export function WorkspaceHistoryControls({ tabs, activeTabId, workspaceId }: {
  tabs: Array<{ id: string }>; activeTabId?: string | null; workspaceId?: string | null;
}) {
  const [state, setState] = useState<{ scope: string | null | undefined; active: string | null | undefined; history: TabVisitHistory }>({
    scope: workspaceId, active: activeTabId, history: activeTabId ? { ids: [activeTabId], index: 0 } : { ids: [], index: -1 },
  });
  if (state.scope !== workspaceId || state.active !== activeTabId) {
    const prior = state.scope === workspaceId ? state.history : { ids: [], index: -1 };
    const next = activeTabId && tabs.some((tab) => tab.id === activeTabId) ? visitTab(prior, activeTabId) : prior;
    setState({ scope: workspaceId, active: activeTabId, history: next });
  }
  const history = state.history;
  const openIds = new Set(tabs.map((tab) => tab.id));
  return <>{([-1, 1] as const).map((direction) => {
    const target = adjacentVisit(history, direction, openIds);
    return <HeaderIconPill key={direction} label={direction === -1 ? 'Back' : 'Forward'} disabled={target === null} yNudge={0}
      onClick={() => {
        if (target === null) return;
        setState((current) => ({ ...current, history: { ...current.history, index: target } }));
        window.dispatchEvent(new CustomEvent('o8:request-select-tab', { detail: { tabId: history.ids[target], workspaceId: workspaceId ?? null } }));
      }} icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={direction === -1 ? 'M19 12H5m6-6-6 6 6 6' : 'M5 12h14m-6-6 6 6-6 6'} />
      </svg>} />;
  })}</>;
}
