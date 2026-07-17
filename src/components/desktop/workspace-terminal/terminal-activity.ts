import type { Dispatch, SetStateAction } from 'react';

import type { TerminalTab } from '@/components/desktop/workspace-terminal/types';

export const TERMINAL_ACTIVITY_COMMIT_MS = 1_000;

export interface TerminalActivityTracker {
  record: (sessionName: string, timestamp?: number) => void;
  merge: (tabs: TerminalTab[]) => TerminalTab[];
  reset: () => void;
  dispose: () => void;
}

export function mergeTerminalActivity(
  tabs: TerminalTab[],
  timestamps: ReadonlyMap<string, number>,
): TerminalTab[] {
  let changed = false;
  const next = tabs.map((tab) => {
    const timestamp = timestamps.get(tab.id);
    if (timestamp === undefined || timestamp <= tab.lastActivity) return tab;
    changed = true;
    return { ...tab, lastActivity: timestamp };
  });
  return changed ? next : tabs;
}

export function createTerminalActivityTracker(options: {
  getTabs: () => TerminalTab[];
  setTabs: Dispatch<SetStateAction<TerminalTab[]>>;
  intervalMs?: number;
}): TerminalActivityTracker {
  const timestamps = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const intervalMs = options.intervalMs ?? TERMINAL_ACTIVITY_COMMIT_MS;

  const flush = (tabId: string) => {
    timers.delete(tabId);
    options.setTabs((current) => mergeTerminalActivity(current, timestamps));
  };

  const reset = () => {
    timers.forEach((timer) => clearTimeout(timer));
    timers.clear();
    timestamps.clear();
  };

  return {
    record(sessionName, timestamp = Date.now()) {
      const tab = options.getTabs().find((candidate) => candidate.tmuxSession === sessionName);
      if (!tab) return;
      timestamps.set(tab.id, timestamp);
      if (timers.has(tab.id)) return;
      timers.set(tab.id, setTimeout(() => flush(tab.id), intervalMs));
    },
    merge(tabs) {
      const ids = new Set(tabs.map((tab) => tab.id));
      for (const tabId of timestamps.keys()) {
        if (!ids.has(tabId)) timestamps.delete(tabId);
      }
      return mergeTerminalActivity(tabs, timestamps);
    },
    reset,
    dispose: reset,
  };
}
