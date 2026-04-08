'use client';

import { memo, useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { RegisteredRepo, TerminalTab } from '@/components/desktop/workspace-terminal/types';
import {
  PhosphorCaretLeft,
  PhosphorCaretRight,
  PhosphorSplitHorizontal,
  PhosphorSplitVertical,
  PhosphorXBold,
  PhosphorXCircle,
} from '@/components/desktop/workspace-terminal/icons';
import { WorkspaceLaunchPicker } from '@/components/desktop/workspace-terminal/WorkspaceLaunchPicker';
import { describeWorkspaceChatTab, workspaceTabPrimaryLabel } from '@/components/desktop/workspace-terminal/utils';
import { CodexIcon, ClaudeIcon } from '@/components/desktop/repo-registry/shared';

interface TabBarProps {
  tabs: TerminalTab[];
  activeTabId: string;
  launchRequestKey?: number;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: (agentId: string, repo?: RegisteredRepo) => void;
  onNewChatTab: (runtime: 'codex' | 'claude-code', repo?: RegisteredRepo) => void;
  onNewLLMChatTab: (repo?: RegisteredRepo) => void;
  scopedRepo?: RegisteredRepo | null;
  onRegisterRepo?: (localPath: string) => void;
  onSplitVertical?: () => void;
  onSplitHorizontal?: () => void;
  canCloseTile?: boolean;
  onCloseTile?: () => void;
}

export const TabBar = memo(function TabBar({
  tabs,
  activeTabId,
  launchRequestKey,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onNewChatTab,
  onNewLLMChatTab,
  scopedRepo,
  onRegisterRepo,
  onSplitVertical,
  onSplitHorizontal,
  canCloseTile,
  onCloseTile,
}: TabBarProps) {
  const tabScrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const syncTabScroll = useCallback(() => {
    const element = tabScrollRef.current;
    if (!element) return;
    setCanScrollLeft(element.scrollLeft > 2);
    setCanScrollRight(element.scrollLeft + element.clientWidth < element.scrollWidth - 2);
  }, []);

  const scrollTabs = useCallback((dir: 'left' | 'right') => {
    tabScrollRef.current?.scrollBy({ left: dir === 'left' ? -180 : 180, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(syncTabScroll);
    return () => cancelAnimationFrame(frame);
  }, [syncTabScroll, tabs.length]);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        height: 32,
        background: 'transparent',
        borderBottom: '0.5px solid var(--t-divider-subtle)',
        flexShrink: 0,
        overflow: 'visible',
        zIndex: 10,
        position: 'relative',
      }}
    >
      <div style={{ position: 'relative', display: 'flex', flex: 1, overflow: 'hidden' }}>
        {canScrollLeft ? (
          <div
            onClick={() => scrollTabs('left')}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 3,
              cursor: 'pointer',
              background: 'linear-gradient(to right, rgba(0, 0, 0, 0.15) 60%, transparent)',
              color: 'var(--t-text-secondary)',
            }}
          >
            <PhosphorCaretLeft size={12} />
          </div>
        ) : null}
        {canScrollRight ? (
          <div
            onClick={() => scrollTabs('right')}
            style={{
              position: 'absolute',
              right: 0,
              top: 0,
              bottom: 0,
              width: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 3,
              cursor: 'pointer',
              background: 'linear-gradient(to left, rgba(0, 0, 0, 0.15) 60%, transparent)',
              color: 'var(--t-text-secondary)',
            }}
          >
            <PhosphorCaretRight size={12} />
          </div>
        ) : null}

        <div
          ref={tabScrollRef}
          onScroll={syncTabScroll}
          onMouseEnter={syncTabScroll}
          style={{
            display: 'flex',
            flex: 1,
            gap: 0,
            overflowX: 'auto',
            overflowY: 'hidden',
            scrollbarWidth: 'none',
          }}
        >
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const rawLabel = workspaceTabPrimaryLabel(tab);
            const chatTabMeta = describeWorkspaceChatTab(tab);
            const primaryLabel = (rawLabel === 'Assistant' || rawLabel === 'Chat') && chatTabMeta?.summary
              ? chatTabMeta.summary
              : rawLabel;
            const tabDetail = tab.orchestrationPacket
              ? (chatTabMeta?.detail ?? tab.orchestrationPacket.branchTarget ?? null)
              : (chatTabMeta?.summary ?? chatTabMeta?.detail ?? null);
            const tabTitle = [primaryLabel, tabDetail, chatTabMeta?.fullSummary]
              .filter((value): value is string => Boolean(value))
              .join(' - ');

            return (
              <button
                type="button"
                key={tab.id}
                onClick={() => onSelectTab(tab.id)}
                title={tabTitle || tab.label}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  paddingTop: 0,
                  paddingBottom: 0,
                  paddingLeft: 12,
                  paddingRight: 12,
                  height: '100%',
                  border: 'none',
                  borderBottom: isActive ? 'none' : '0.5px solid transparent',
                  background: isActive ? 'var(--t-panel, #fff)' : 'transparent',
                  color: isActive ? 'var(--t-text, #111827)' : 'var(--t-text-secondary, #5b6475)',
                  fontSize: 12,
                  fontWeight: isActive ? 600 : 400,
                  fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
                  letterSpacing: '-0.008em',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  transition: 'color 120ms ease, background 120ms ease',
                  borderRadius: 0,
                  marginBottom: isActive ? -0.5 : 0,
                  borderRight: '0.5px solid var(--t-divider-subtle)',
                }}
              >
                {tab.unseen ? (
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#2563eb', flexShrink: 0 }} />
                ) : null}
                {tab.chatRuntime === 'claude-code' ? (
                  <ClaudeIcon size={14} />
                ) : tab.chatRuntime === 'codex' ? (
                  <CodexIcon size={14} />
                ) : null}
                <span
                  style={{
                    maxWidth: 160,
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {primaryLabel}
                </span>
                {tabs.length > 1 ? (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(event) => {
                      event.stopPropagation();
                      onCloseTab(tab.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.stopPropagation();
                        onCloseTab(tab.id);
                      }
                    }}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 16,
                      height: 16,
                      borderRadius: 4,
                      marginLeft: 4,
                      color: 'var(--t-text-secondary)',
                      cursor: 'pointer',
                      transition: 'background 100ms, color 100ms',
                    }}
                    onMouseEnter={(event) => {
                      (event.target as HTMLElement).style.background = 'rgba(239, 68, 68, 0.15)';
                      (event.target as HTMLElement).style.color = '#ef4444';
                    }}
                    onMouseLeave={(event) => {
                      (event.target as HTMLElement).style.background = 'transparent';
                      (event.target as HTMLElement).style.color = '#475569';
                    }}
                  >
                    <PhosphorXBold size={10} />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <WorkspaceLaunchPicker
        launchRequestKey={launchRequestKey}
        scopedRepo={scopedRepo}
        onRegisterRepo={onRegisterRepo}
        onNewTab={onNewTab}
        onNewChatTab={onNewChatTab}
        onNewLLMChatTab={onNewLLMChatTab}
      />

      {onSplitVertical || onSplitHorizontal || (canCloseTile && onCloseTile) ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            paddingRight: 6,
            flexShrink: 0,
            borderLeft: '0.5px solid var(--t-divider-subtle)',
            marginLeft: 2,
            paddingLeft: 4,
          }}
        >
          {onSplitVertical ? (
            <button
              type="button"
              onClick={onSplitVertical}
              aria-label="Split vertically"
              style={chromeButtonStyle}
              onMouseEnter={hoverChromeOn}
              onMouseLeave={hoverChromeOff}
            >
              <PhosphorSplitVertical size={14} />
            </button>
          ) : null}
          {onSplitHorizontal ? (
            <button
              type="button"
              onClick={onSplitHorizontal}
              aria-label="Split horizontally"
              style={chromeButtonStyle}
              onMouseEnter={hoverChromeOn}
              onMouseLeave={hoverChromeOff}
            >
              <PhosphorSplitHorizontal size={14} />
            </button>
          ) : null}
          {canCloseTile && onCloseTile ? (
            <button
              type="button"
              onClick={onCloseTile}
              aria-label="Close tile"
              style={chromeButtonStyle}
              onMouseEnter={closeHoverOn}
              onMouseLeave={closeHoverOff}
            >
              <PhosphorXCircle size={14} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const chromeButtonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 22,
  height: 22,
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  color: 'var(--t-text-faint)',
  cursor: 'pointer',
  transition: 'background 100ms, color 100ms',
};

function hoverChromeOn(event: MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'var(--t-hover)';
  event.currentTarget.style.color = 'var(--t-text-secondary)';
}

function hoverChromeOff(event: MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'transparent';
  event.currentTarget.style.color = 'var(--t-text-faint)';
}

function closeHoverOn(event: MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'rgba(239, 68, 68, 0.08)';
  event.currentTarget.style.color = '#ef4444';
}

function closeHoverOff(event: MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'transparent';
  event.currentTarget.style.color = 'var(--t-text-faint)';
}
