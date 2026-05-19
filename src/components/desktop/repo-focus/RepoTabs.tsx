'use client';

import type { RepoFocusTabId } from './types';
import { REPO_FOCUS_FONT } from './utils';

const DEFAULT_TABS: Array<{ id: RepoFocusTabId; label: string }> = [
  { id: 'chats', label: 'Chats' },
  { id: 'agents', label: 'Packets' },
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
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        borderTopWidth: 1,
        borderTopStyle: 'solid',
        borderTopColor: 'var(--t-divider-subtle)',
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
        background: 'color-mix(in srgb, var(--t-panel) 92%, transparent)',
        paddingTop: 4,
        paddingRight: 10,
        paddingBottom: 4,
        paddingLeft: 10,
        overflowX: 'auto',
        scrollbarWidth: 'none',
      }}
    >
      {tabs.map((tab) => {
        const selected = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onTabChange(tab.id)}
            style={{
              position: 'relative',
              minHeight: 28,
              borderWidth: 0,
              background: 'transparent',
              color: selected ? 'var(--t-brand-orange, #FF5A1F)' : 'var(--t-text-muted)',
              cursor: 'pointer',
              fontFamily: REPO_FOCUS_FONT,
              fontSize: 10.5,
              fontWeight: selected ? 620 : 500,
              letterSpacing: '-0.01em',
              paddingTop: 0,
              paddingRight: 10,
              paddingBottom: 0,
              paddingLeft: 10,
              whiteSpace: 'nowrap',
            }}
          >
            {tab.label}
            {selected ? (
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  left: 10,
                  right: 10,
                  bottom: 2,
                  height: 2,
                  borderRadius: 999,
                  background: 'var(--t-brand-orange, #FF5A1F)',
                }}
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
