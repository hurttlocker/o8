'use client';

import type { RepoFocusTabId } from './types';
import { REPO_FOCUS_FONT } from './utils';

const DEFAULT_TABS: Array<{ id: RepoFocusTabId; label: string }> = [
  { id: 'control', label: 'Control' },
  { id: 'chats', label: 'Chats' },
];

interface RepoTabsProps {
  activeTab: RepoFocusTabId;
  onTabChange: (tab: RepoFocusTabId) => void;
  /**
   * Tabs to render — defaults to the repo-focus control set. Workspace
   * notes live in the main o8 panel, not this left-panel surface.
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
        background: 'color-mix(in srgb, var(--t-panel) 70%, transparent)',
        paddingTop: 2,
        paddingRight: 10,
        paddingBottom: 2,
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
              minHeight: 24,
              borderWidth: 0,
              background: 'transparent',
              color: selected ? 'var(--t-brand-orange, #FF5A1F)' : 'var(--t-text-muted)',
              cursor: 'pointer',
              fontFamily: REPO_FOCUS_FONT,
              fontSize: 10.5,
              fontWeight: selected ? 620 : 500,
              letterSpacing: '-0.01em',
              paddingTop: 0,
              paddingRight: 8,
              paddingBottom: 0,
              paddingLeft: 8,
              whiteSpace: 'nowrap',
            }}
          >
            {tab.label}
            {selected ? (
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  left: 8,
                  right: 8,
                  bottom: 0,
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
