'use client';

import type { RepoFocusTabId } from './types';
import { REPO_FOCUS_FONT } from './utils';

const TABS: Array<{ id: RepoFocusTabId; label: string }> = [
  { id: 'agents', label: 'Agents' },
  { id: 'context', label: 'Context' },
  { id: 'mission', label: 'Mission' },
  { id: 'spec', label: 'Spec' },
  { id: 'files', label: 'Files' },
];

interface RepoTabsProps {
  activeTab: RepoFocusTabId;
  onTabChange: (tab: RepoFocusTabId) => void;
}

export function RepoTabs({ activeTab, onTabChange }: RepoTabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Repo focus tabs"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
        borderTopWidth: 1,
        borderTopStyle: 'solid',
        borderTopColor: 'var(--t-divider-subtle)',
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
        background: 'var(--t-panel)',
      }}
    >
      {TABS.map((tab) => {
        const selected = tab.id === activeTab;
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
              borderRightWidth: tab.id === 'files' ? 0 : 1,
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
