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
import { chromeNeoSurface, chromeNeoHoverSurface } from '@/components/desktop/chrome/ChromeButton';

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
        height: 36,
        // Match the chat-surface bg so the TabBar blends with the workspace
        // content below instead of reading as a separate gray strip.
        background: 'var(--t-chat-surface-bg, #ffffff)',
        borderBottomWidth: '0.5px',
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
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
              background: 'linear-gradient(to right, var(--t-chat-surface-bg, #ffffff) 60%, transparent)',
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
              background: 'linear-gradient(to left, var(--t-chat-surface-bg, #ffffff) 60%, transparent)',
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
            const isOrchestrator = tab.kind === 'orchestrator';
            const rawLabel = workspaceTabPrimaryLabel(tab);
            const chatTabMeta = describeWorkspaceChatTab(tab);
            const primaryLabel = (rawLabel === 'Assistant' || rawLabel === 'Agent' || rawLabel === 'Chat') && chatTabMeta?.summary
              ? chatTabMeta.summary
              : rawLabel;
            const tabDetail = tab.orchestrationPacket
              ? (chatTabMeta?.detail ?? tab.orchestrationPacket.branchTarget ?? null)
              : (chatTabMeta?.summary ?? chatTabMeta?.detail ?? null);
            const tabTitle = [primaryLabel, tabDetail, chatTabMeta?.fullSummary]
              .filter((value): value is string => Boolean(value))
              .join(' - ');

            const neoSurface = chromeNeoSurface(isActive);
            return (
              <button
                type="button"
                key={tab.id}
                onClick={() => onSelectTab(tab.id)}
                title={tabTitle || tab.label}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  paddingTop: 5,
                  paddingBottom: 5,
                  paddingLeft: 12,
                  paddingRight: 10,
                  marginTop: 4,
                  marginBottom: 4,
                  marginLeft: 3,
                  marginRight: 3,
                  borderWidth: 0,
                  borderStyle: 'none',
                  borderRadius: 9,
                  background: isOrchestrator && isActive
                    ? 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))'
                    : neoSurface.background,
                  boxShadow: isOrchestrator && isActive
                    ? '0 1px 4px rgba(37, 99, 235, 0.12), inset 0 1px 0 rgba(37, 99, 235, 0.1)'
                    : neoSurface.boxShadow,
                  color: isOrchestrator
                    ? (isActive ? 'var(--t-text)' : 'var(--t-text-secondary)')
                    : (isActive ? 'var(--t-text)' : 'var(--t-text-secondary)'),
                  fontSize: 12,
                  fontWeight: isActive ? 560 : 460,
                  fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
                  letterSpacing: '-0.008em',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  transition: 'background 150ms ease, box-shadow 150ms ease, color 120ms ease',
                  position: 'relative',
                }}
                onMouseEnter={(event) => {
                  if (isActive) return;
                  const hover = chromeNeoHoverSurface();
                  event.currentTarget.style.background = hover.background;
                  event.currentTarget.style.boxShadow = hover.boxShadow;
                }}
                onMouseLeave={(event) => {
                  if (isActive) return;
                  event.currentTarget.style.background = neoSurface.background;
                  event.currentTarget.style.boxShadow = neoSurface.boxShadow;
                }}
              >
                {tab.unseen ? (
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#2563eb', flexShrink: 0 }} />
                ) : null}
                {tab.kind === 'orchestrator' || tab.chatRuntime === 'claude-code' ? (
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
                {tabs.length > 1 && !isOrchestrator ? (
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
            gap: 2,
            paddingRight: 8,
            paddingLeft: 2,
            flexShrink: 0,
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
  alignSelf: 'center',
  width: 24,
  height: 24,
  borderRadius: 6,
  borderWidth: 0,
  background: 'transparent',
  color: 'var(--t-text-muted)',
  cursor: 'pointer',
  transition: 'background 100ms, color 100ms',
};

function hoverChromeOn(event: MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'var(--t-hover)';
  event.currentTarget.style.color = 'var(--t-text)';
}

function hoverChromeOff(event: MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'transparent';
  event.currentTarget.style.color = 'var(--t-text-muted)';
}

function closeHoverOn(event: MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'rgba(239, 68, 68, 0.08)';
  event.currentTarget.style.color = '#ef4444';
}

function closeHoverOff(event: MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'transparent';
  event.currentTarget.style.color = 'var(--t-text-faint)';
}
