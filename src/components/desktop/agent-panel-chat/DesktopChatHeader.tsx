'use client';

import React, { memo } from 'react';
import { ChevronRight } from 'lucide-react';
import { CaretDown } from '@phosphor-icons/react';
import { ContextUsageRing } from '@/components/ContextUsageRing';
import { sessionPickerTitle, sessionPickerRowSubtitle } from './shared';
import type { DesktopChatHeaderProps } from './types';

export const DesktopChatHeader = memo(function DesktopChatHeader({
  pickerRef,
  pickerOpen,
  setPickerOpen,
  projectGroups,
  selectedSession,
  activeTitle,
  activeChips,
  emptyStateLabel,
  connectionDotColor,
  handleSessionFocus,
  expandedGroup,
  setExpandedGroup,
  diffStats,
  onOpenDiff,
  setDiffOpen,
}: DesktopChatHeaderProps) {
  const diffIsActive = diffStats.files > 0;

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 44,
        paddingLeft: 16,
        paddingRight: 12,
        backgroundColor: 'transparent',
        borderBottomWidth: '0.5px',
        borderBottomStyle: 'solid',
        borderBottomColor: 'rgba(0, 0, 0, 0.04)',
        zIndex: 10,
        position: 'relative',
      }}
    >
      <div ref={pickerRef} style={{ minWidth: 0, flex: 1, position: 'relative' }}>
        <button
          type="button"
          onClick={() => setPickerOpen((p) => !p)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            paddingTop: 6,
            paddingBottom: 6,
            paddingLeft: 8,
            paddingRight: 8,
            margin: 0,
            borderWidth: 0,
            borderRadius: 10,
            backgroundColor: 'transparent',
            cursor: 'pointer',
            textAlign: 'left' as const,
            WebkitTapHighlightColor: 'transparent',
            transition: 'background-color 150ms ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(0, 0, 0, 0.03)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
          }}
          aria-label="Switch lane"
          aria-expanded={pickerOpen}
        >
          <span style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            flexShrink: 0,
            backgroundColor: connectionDotColor,
            animation: (connectionDotColor === '#ff9f0a' || connectionDotColor === '#f59e0b')
              ? 'reviewingBreathe 2.4s ease-in-out infinite' : 'none',
          }} />
          <span style={{
            fontSize: 14,
            fontWeight: 600,
            color: '#111827',
            letterSpacing: '-0.02em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}>
            {activeTitle}
          </span>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {activeChips.length > 0 ? (
              <span style={{
                fontSize: 11,
                fontWeight: 500,
                color: 'var(--t-text-faint)',
                letterSpacing: '-0.01em',
                whiteSpace: 'nowrap',
              }}>
                {activeChips.map((chip) => chip.label).join(' \u00b7 ')}
              </span>
            ) : null}
            <CaretDown
              size={12}
              weight="bold"
              color="var(--t-text-faint)"
              style={{
                flexShrink: 0,
                transition: 'transform 200ms cubic-bezier(0.32, 0.72, 0, 1)',
                transform: pickerOpen ? 'rotate(180deg)' : 'rotate(0deg)',
              }}
            />
          </div>
        </button>

        {pickerOpen ? (
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: 4,
              minWidth: 280,
              maxWidth: 340,
              maxHeight: 360,
              overflowY: 'auto',
              paddingTop: 6,
              paddingRight: 6,
              paddingBottom: 6,
              paddingLeft: 6,
              borderRadius: 12,
              backgroundColor: 'rgba(255, 255, 255, 0.96)',
              backdropFilter: 'blur(20px) saturate(1.8)',
              WebkitBackdropFilter: 'blur(20px) saturate(1.8)',
              boxShadow: '0 8px 32px rgba(0, 0, 0, 0.12), 0 0 0 0.5px rgba(0, 0, 0, 0.06)',
              scrollbarWidth: 'none',
              zIndex: 100,
            } as React.CSSProperties}
          >
            {projectGroups.length === 0 ? (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 76,
                paddingTop: 10,
                paddingBottom: 10,
                paddingLeft: 12,
                paddingRight: 12,
                borderRadius: 10,
                color: 'var(--t-text-muted)',
                fontSize: 12,
                fontWeight: 500,
                backgroundColor: 'rgba(0, 0, 0, 0.03)',
              }}>
                {emptyStateLabel}
              </div>
            ) : null}
            {projectGroups.map((group, gi) => {
            const isExpanded = expandedGroup === group.workspace;
            const isSingle = group.sessions.length === 1;
            const containsSelected = group.sessions.some((s) => s.sessionKey === selectedSession?.sessionKey);
            const singleSession = isSingle ? group.sessions[0] : null;
            const groupTitle = singleSession ? sessionPickerTitle(singleSession) : group.projectName;
            const groupSubtitle = singleSession ? sessionPickerRowSubtitle(singleSession) : group.summary;
            const dotColor = group.hasRunning
              ? '#34c759'
              : group.bestContextPct >= 75
                ? '#ff9f0a'
                : '#8e8e93';

            return (
              <div key={group.workspace}>
                <button
                  type="button"
                  onClick={() => {
                    if (isSingle) {
                      handleSessionFocus(group.sessions[0].sessionKey);
                      setPickerOpen(false);
                    } else {
                      setExpandedGroup(isExpanded ? null : group.workspace);
                    }
                  }}
                  onMouseEnter={(e) => {
                    if (!(containsSelected && !isExpanded)) e.currentTarget.style.backgroundColor = 'rgba(0, 0, 0, 0.03)';
                  }}
                  onMouseLeave={(e) => {
                    if (!(containsSelected && !isExpanded)) e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    paddingTop: 8,
                    paddingBottom: 8,
                    paddingLeft: 10,
                    paddingRight: 10,
                    borderWidth: 0,
                    borderRadius: 8,
                    backgroundColor: containsSelected && !isExpanded
                      ? 'rgba(37, 99, 235, 0.06)'
                      : 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left' as const,
                    transition: 'background-color 120ms ease',
                    minHeight: 44,
                  }}
                >
                  <span style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    flexShrink: 0,
                    backgroundColor: dotColor,
                  }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{
                      fontSize: 13,
                      fontWeight: containsSelected ? 600 : 500,
                      color: containsSelected ? '#111827' : 'var(--t-text)',
                      lineHeight: 1.3,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {groupTitle}
                    </div>
                    <div style={{
                      fontSize: 11,
                      color: 'var(--t-text-muted)',
                      lineHeight: 1.3,
                      marginTop: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {groupSubtitle}
                      {group.mostRecentTime ? ` \u00b7 ${group.mostRecentTime}` : ''}
                    </div>
                  </div>
                  {containsSelected && isSingle ? (
                    <span style={{ fontSize: 11, fontWeight: 600, color: '#2563eb', flexShrink: 0 }}>
                      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}><path d="M20 6 9 17l-5-5" /></svg>
                    </span>
                  ) : !isSingle ? (
                    <ChevronRight
                      size={14}
                      strokeWidth={2.2}
                      style={{
                        flexShrink: 0,
                        color: 'var(--t-text-muted)',
                        transition: 'transform 220ms cubic-bezier(0.32, 0.72, 0, 1)',
                        transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                      }}
                    />
                  ) : null}
                </button>

                {isExpanded && !isSingle ? (
                  <div style={{
                    marginLeft: 14,
                    borderLeftWidth: 1,
                    borderLeftStyle: 'solid',
                    borderLeftColor: 'rgba(0, 0, 0, 0.06)',
                    paddingLeft: 8,
                    marginTop: 2,
                    marginBottom: 4,
                  }}>
                    {group.sessions.map((session) => {
                      const isActive = session.sessionKey === selectedSession?.sessionKey;
                      const isRunning = session.status === 'running' || session.status === 'reviewing';
                      const sessionPercent = Math.round(session.context?.usedPercent ?? 0);
                      const isSessionReviewing = !isRunning && session.status === 'reviewing';
                      const sDotColor = isRunning ? '#34c759' : isSessionReviewing ? '#a78bfa' : sessionPercent >= 75 ? '#ff9f0a' : '#8e8e93';
                      const name = sessionPickerTitle(session);
                      const subtitle = sessionPickerRowSubtitle(session);

                      return (
                        <button
                          key={session.sessionKey}
                          type="button"
                          onClick={() => {
                            handleSessionFocus(session.sessionKey);
                            setPickerOpen(false);
                          }}
                          onMouseEnter={(e) => {
                            if (!isActive) e.currentTarget.style.backgroundColor = 'rgba(0, 0, 0, 0.03)';
                          }}
                          onMouseLeave={(e) => {
                            if (!isActive) e.currentTarget.style.backgroundColor = 'transparent';
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            width: '100%',
                            paddingTop: 8,
                            paddingBottom: 8,
                            paddingLeft: 10,
                            paddingRight: 10,
                            borderWidth: 0,
                            borderRadius: 8,
                            backgroundColor: isActive ? 'rgba(37, 99, 235, 0.06)' : 'transparent',
                            cursor: 'pointer',
                            textAlign: 'left' as const,
                            transition: 'background-color 120ms ease',
                            minHeight: 44,
                          }}
                        >
                          <span style={{
                            width: 5,
                            height: 5,
                            borderRadius: '50%',
                            flexShrink: 0,
                            backgroundColor: sDotColor,
                          }} />
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{
                              fontSize: 12,
                              fontWeight: isActive ? 600 : 400,
                              color: isActive ? '#111827' : 'var(--t-text)',
                              lineHeight: 1.3,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}>
                              {name}
                            </div>
                            {subtitle ? (
                              <div style={{
                                fontSize: 11,
                                color: 'var(--t-text-muted)',
                                lineHeight: 1.3,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                marginTop: 1,
                              }}>
                                {subtitle}
                              </div>
                            ) : null}
                          </div>
                          <ContextUsageRing percent={sessionPercent} size={22} />
                          {isActive ? (
                            <span style={{ flexShrink: 0, color: '#2563eb', display: 'flex' }}>
                              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}><path d="M20 6 9 17l-5-5" /></svg>
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                {gi < projectGroups.length - 1 ? (
                  <div style={{
                    height: '0.5px',
                    backgroundColor: 'rgba(0, 0, 0, 0.06)',
                    marginTop: 3,
                    marginBottom: 3,
                    marginLeft: 10,
                    marginRight: 10,
                  }} />
                ) : null}
              </div>
            );
            })}
          </div>
        ) : null}
      </div>

      {diffIsActive ? (
        <button
          type="button"
          onClick={() => onOpenDiff ? onOpenDiff() : setDiffOpen(true)}
          style={{
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 8px',
            borderRadius: 8,
            border: 'none',
            background: 'transparent',
            color: 'var(--t-text-muted)',
            fontSize: 11,
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'background 150ms ease',
            fontFamily: '"SF Mono", ui-monospace, monospace',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0, 0, 0, 0.04)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          aria-label="Open diff sheet"
        >
          <span style={{ color: '#22c55e', fontWeight: 600 }}>+{diffStats.additions}</span>
          <span style={{ color: '#ef4444', fontWeight: 600 }}>-{diffStats.deletions}</span>
          <span style={{ color: 'var(--t-text-faint)', fontWeight: 500 }}>{diffStats.files}f</span>
        </button>
      ) : null}
    </header>
  );
});
