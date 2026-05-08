'use client';

import type { RepoFocusTabId } from './types';
import { REPO_FOCUS_FONT } from './utils';

const DEFAULT_TABS: Array<{ id: RepoFocusTabId; label: string }> = [
  { id: 'agents', label: 'Agents' },
  { id: 'context', label: 'Context' },
  { id: 'mission', label: 'Mission' },
  { id: 'spec', label: 'o8.md' },
  { id: 'files', label: 'Files' },
];

interface RepoTabsProps {
  activeTab: RepoFocusTabId;
  onTabChange: (tab: RepoFocusTabId) => void;
  /**
   * Tabs to render — defaults to the full 5-tab repo set. The project
   * panel passes a 4-tab list (no o8.md) when the panel is in
   * project-wide mode.
   */
  tabs?: Array<{ id: RepoFocusTabId; label: string }>;
}

export function RepoTabs({ activeTab, onTabChange, tabs = DEFAULT_TABS }: RepoTabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Repo focus tabs"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))`,
        borderTopWidth: 1,
        borderTopStyle: 'solid',
        borderTopColor: 'var(--t-divider-subtle)',
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
        background: 'var(--t-panel)',
      }}
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === activeTab;
        const isLast = index === tabs.length - 1;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onTabChange(tab.id)}
            style={{
              minHeight: 44,
              borderWidth: 0,
              borderRightWidth: isLast ? 0 : 1,
              borderRightStyle: 'solid',
              borderRightColor: 'var(--t-divider-subtle)',
              background: selected ? 'var(--t-input-bg)' : 'transparent',
              color: selected ? 'var(--t-brand-orange, #FF5A1F)' : 'var(--t-text-muted)',
              cursor: 'pointer',
              fontFamily: REPO_FOCUS_FONT,
              fontSize: 12,
              fontWeight: selected ? 560 : 500,
              letterSpacing: '-0.01em',
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
