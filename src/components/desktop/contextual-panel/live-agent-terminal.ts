export interface LiveAgentTerminalTab {
  id: string;
  label: string;
  kind: string;
  tmuxSession: string | null;
  readOnly?: boolean;
  createdAt: number;
  lastActivity: number;
}

export interface AttachLiveAgentTerminalResult<T extends LiveAgentTerminalTab> {
  tabs: T[];
  activeTabId: string;
  nextTabCount: number;
}

function shortRunId(session: string): string {
  return session.startsWith('cortex-run-')
    ? session.slice('cortex-run-'.length, 'cortex-run-'.length + 6)
    : session.slice(0, 6);
}

export function attachLiveAgentTerminalTab<T extends LiveAgentTerminalTab>(
  tabs: T[],
  options: {
    session: string;
    label?: string;
    tabCount: number;
    now?: number;
  },
): AttachLiveAgentTerminalResult<T> {
  const now = options.now ?? Date.now();
  const existing = tabs.find((entry) => entry.kind === 'terminal' && entry.tmuxSession === options.session);
  if (existing) {
    const nextTabs = tabs.map((entry) => (
      entry.id === existing.id
        ? {
            ...entry,
            label: options.label || entry.label,
            lastActivity: now,
          }
        : entry
    ));
    return {
      tabs: nextTabs,
      activeTabId: existing.id,
      nextTabCount: options.tabCount,
    };
  }

  const nextTabCount = options.tabCount + 1;
  const nextTab = {
    id: `bottom-agent-${nextTabCount}`,
    label: options.label ?? `run·${shortRunId(options.session)}`,
    kind: 'terminal' as const,
    tmuxSession: options.session,
    readOnly: true,
    createdAt: now,
    lastActivity: now,
  } as T;
  return {
    tabs: [...tabs, nextTab],
    activeTabId: nextTab.id,
    nextTabCount,
  };
}
