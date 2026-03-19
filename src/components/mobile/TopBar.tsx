import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { TopBarProps } from './types';
import { buildProjectGroups } from './utils';
import { useAlerts } from '@/lib/alerts/context';
import { SpeedDialButton } from './SpeedDial';

export const TopBar = memo(function TopBar({
  snapshot,
  selectedSession,
  selectedReviewPacket,
  selectedReviewFile,
  reviewFiles,
  isOwnedCodexSession,
  isHeaderCompact,
  headerVisible,
  pendingApprovalsCount,
  wsConnectionState,
  compactLine,
  squadPickerOpen,
  activeScreen,
  onNavigate,
  onOpenControls,
  onOpenDiff,
  onOpenAlerts,
  onToggleSquadPicker,
  onSessionFocus,
}: TopBarProps) {
  const { hasUnread } = useAlerts();
  const pickerRef = useRef<HTMLDivElement>(null);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);

  // Reset expanded group when picker closes
  useEffect(() => {
    if (!squadPickerOpen) setExpandedGroup(null);
  }, [squadPickerOpen]);

  const projectGroups = useMemo(
    () => buildProjectGroups(snapshot, selectedSession),
    [snapshot, selectedSession],
  );

  // Close picker on outside tap
  const handleOutsideTap = useCallback((e: MouseEvent | TouchEvent) => {
    if (squadPickerOpen && pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
      onToggleSquadPicker();
    }
  }, [squadPickerOpen, onToggleSquadPicker]);

  useEffect(() => {
    if (squadPickerOpen) {
      document.addEventListener('touchstart', handleOutsideTap, { passive: true });
      document.addEventListener('mousedown', handleOutsideTap);
      return () => {
        document.removeEventListener('touchstart', handleOutsideTap);
        document.removeEventListener('mousedown', handleOutsideTap);
      };
    }
  }, [squadPickerOpen, handleOutsideTap]);

  const connectionDotColor = wsConnectionState === 'connected'
    ? '#34c759'
    : wsConnectionState === 'connecting'
      ? '#ff9f0a'
      : '#ff3b30';
  const totalAdditions = reviewFiles.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const totalDeletions = reviewFiles.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const focusedAdditions = selectedReviewFile?.additions ?? totalAdditions;
  const focusedDeletions = selectedReviewFile?.deletions ?? totalDeletions;
  const diffFileLabel = reviewFiles.length === 1 ? 'file' : 'files';
  const activeTitle = compactLine(
    isOwnedCodexSession
      ? selectedReviewPacket?.title ?? selectedSession?.name ?? selectedSession?.currentTask
      : snapshot.review?.pullRequest?.title ?? selectedSession?.name ?? selectedSession?.currentTask,
    selectedSession?.isCurrentSession ? 'Q ↔ Mister live' : selectedSession?.name ?? 'Current session',
    26,
  );
  const activeSubtitle = compactLine(
    isOwnedCodexSession
      ? (selectedReviewPacket?.repoSlug && selectedReviewPacket?.branch ? `/${selectedReviewPacket.repoSlug}/${selectedReviewPacket.branch}` : selectedSession?.sessionKey)
      : (snapshot.review ? `/${snapshot.review.repoSlug}/${snapshot.review.branch}` : selectedSession?.sessionKey),
    selectedSession?.sessionKey ?? 'mobile/live',
    42,
  );
  const headerLabel = isOwnedCodexSession
    ? (selectedSession?.runtimeSurface?.capabilities.interrupt ? 'Codex live' : selectedSession?.runtimeSurface?.capabilities.sendInput ? 'Codex chat' : 'Codex watch')
    : selectedSession?.runtime === 'codex'
      ? 'Codex'
      : selectedSession?.status === 'running'
        ? 'Live'
        : snapshot.review?.pullRequest
          ? 'Review'
          : 'Session';

  return (
    <header
      className="remodex-topbar"
      data-compact={isHeaderCompact ? 'true' : 'false'}
      data-context-visible="false"
      data-visible={headerVisible ? 'true' : 'false'}
      data-picker-open={squadPickerOpen ? 'true' : 'false'}
      style={{
        transition: 'all 250ms cubic-bezier(0.32, 0.72, 0, 1)',
      }}
    >
      {/* Hamburger menu — first grid column */}
      <SpeedDialButton
        activeScreen={activeScreen}
        onNavigate={onNavigate}
        approvalCount={pendingApprovalsCount}
      />

      {/* Tappable title area — opens squad picker */}
      <div ref={pickerRef} style={{ minWidth: 0, flex: 1, position: 'relative' }}>
        <button
          type="button"
          onClick={onToggleSquadPicker}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            width: '100%',
            padding: 0,
            margin: 0,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            textAlign: 'left',
            WebkitTapHighlightColor: 'transparent',
          }}
          aria-label="Switch session"
          aria-expanded={squadPickerOpen}
        >
          {isHeaderCompact ? (
            /* ── Collapsed pill — agent name + status dot ── */
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '4px 12px',
              borderRadius: 20,
              background: 'rgba(255,255,255,0.75)',
              backdropFilter: 'blur(20px) saturate(1.6)',
              WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
              border: '1px solid rgba(0,0,0,0.06)',
              maxWidth: '100%',
            }}>
              <span style={{
                width: 7, height: 7, borderRadius: '50%',
                background: connectionDotColor,
                flexShrink: 0,
                boxShadow: connectionDotColor === '#34c759' ? '0 0 6px rgba(52,199,89,0.4)' : 'none',
              }} />
              <span style={{
                fontSize: 14, fontWeight: 600,
                color: '#0a0a0a',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}>
                {activeTitle}
              </span>
              <ChevronDown size={12} strokeWidth={2.5}
                style={{
                  flexShrink: 0, color: '#8e8e93',
                  transition: 'transform 260ms cubic-bezier(0.32, 0.72, 0, 1)',
                  transform: squadPickerOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                }}
              />
            </div>
          ) : (
            /* ── Expanded header — full details ── */
            <>
              <div className="remodex-title-shell" style={{ minWidth: 0, flex: 1 }}>
                <div className="remodex-title-stack">
                  <span className="remodex-title-kicker">
                    <span
                      style={{
                        display: 'inline-block',
                        width: '6px',
                        height: '6px',
                        borderRadius: '50%',
                        backgroundColor: connectionDotColor,
                        marginRight: '5px',
                        verticalAlign: 'middle',
                      }}
                      title={`WebSocket: ${wsConnectionState ?? 'unknown'}`}
                    />
                    {headerLabel}
                  </span>
                  <h1>{activeTitle}</h1>
                  <p>{activeSubtitle}</p>
                </div>
              </div>
              <ChevronDown
                size={14}
                strokeWidth={2.2}
                style={{
                  flexShrink: 0,
                  color: '#8e8e93',
                  transition: 'transform 260ms cubic-bezier(0.32, 0.72, 0, 1)',
                  transform: squadPickerOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                }}
              />
            </>
          )}
        </button>

        {/* Squad picker dropdown — grouped by project */}
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            left: '-12px',
            right: '-12px',
            zIndex: 100,
            borderRadius: '14px',
            background: 'rgba(255, 255, 255, 0.96)',
            backdropFilter: 'blur(40px) saturate(1.8)',
            WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
            boxShadow: '0 20px 60px rgba(15, 23, 42, 0.18), 0 1px 3px rgba(15, 23, 42, 0.08)',
            padding: '8px',
            maxHeight: '60vh',
            overflowY: 'auto',
            WebkitOverflowScrolling: 'touch',
            opacity: squadPickerOpen ? 1 : 0,
            transform: squadPickerOpen ? 'translateY(0) scale(1)' : 'translateY(-8px) scale(0.97)',
            pointerEvents: squadPickerOpen ? 'auto' : 'none',
            transition: 'opacity 220ms cubic-bezier(0.32, 0.72, 0, 1), transform 220ms cubic-bezier(0.32, 0.72, 0, 1)',
          }}
        >
          {projectGroups.map((group) => {
            const isExpanded = expandedGroup === group.workspace;
            const isSingle = group.sessions.length === 1;
            const containsSelected = group.sessions.some((s) => s.id === selectedSession?.id);
            const dotColor = group.hasRunning
              ? '#34c759'
              : group.bestContextPct >= 75
                ? '#ff9f0a'
                : '#8e8e93';

            return (
              <div key={group.workspace}>
                {/* Group header */}
                <button
                  type="button"
                  onClick={() => {
                    if (isSingle) {
                      onSessionFocus(group.sessions[0].id);
                      onToggleSquadPicker();
                    } else {
                      setExpandedGroup(isExpanded ? null : group.workspace);
                    }
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    width: '100%',
                    padding: '10px 12px',
                    border: 'none',
                    borderRadius: '10px',
                    background: containsSelected && !isExpanded
                      ? 'rgba(37, 99, 235, 0.08)'
                      : 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background 120ms ease',
                    WebkitTapHighlightColor: 'transparent',
                    minHeight: '44px',
                  }}
                >
                  <span style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    backgroundColor: dotColor,
                    flexShrink: 0,
                    boxShadow: group.hasRunning ? `0 0 6px ${dotColor}` : 'none',
                  }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{
                      fontSize: '14px',
                      fontWeight: containsSelected ? 600 : 500,
                      color: containsSelected ? '#2563eb' : '#111827',
                      lineHeight: 1.3,
                    }}>
                      {group.projectName}
                    </div>
                    <div style={{
                      fontSize: '12px',
                      color: '#8e8e93',
                      lineHeight: 1.3,
                      marginTop: '1px',
                    }}>
                      {group.summary}
                      {group.mostRecentTime ? ` · ${group.mostRecentTime}` : ''}
                    </div>
                  </div>
                  {containsSelected && isSingle ? (
                    <span style={{ fontSize: '11px', fontWeight: 600, color: '#2563eb', flexShrink: 0 }}>✓</span>
                  ) : !isSingle ? (
                    <ChevronRight
                      size={14}
                      strokeWidth={2.2}
                      style={{
                        flexShrink: 0,
                        color: '#8e8e93',
                        transition: 'transform 220ms cubic-bezier(0.32, 0.72, 0, 1)',
                        transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                      }}
                    />
                  ) : null}
                </button>

                {/* Expanded session list */}
                {isExpanded && !isSingle ? (
                  <div style={{
                    marginLeft: '18px',
                    borderLeft: '2px solid rgba(37, 99, 235, 0.12)',
                    paddingLeft: '8px',
                    marginTop: '2px',
                    marginBottom: '4px',
                  }}>
                    {group.sessions.map((session) => {
                      const isActive = session.id === selectedSession?.id;
                      const isRunning = session.status === 'running' || session.status === 'reviewing';
                      const sessionPercent = Math.round(session.context?.usedPercent ?? 0);
                      const sDotColor = isRunning ? '#34c759' : sessionPercent >= 75 ? '#ff9f0a' : '#8e8e93';
                      const name = session.name ?? session.sessionKey ?? session.id;
                      const subtitle = session.currentTask
                        ?? session.branch?.replace(/^(feat|fix|batch|chore|refactor)\//, '')
                        ?? session.sessionKey
                        ?? '';

                      return (
                        <button
                          key={session.id}
                          type="button"
                          onClick={() => {
                            onSessionFocus(session.id);
                            onToggleSquadPicker();
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '10px',
                            width: '100%',
                            padding: '8px 10px',
                            border: 'none',
                            borderRadius: '10px',
                            background: isActive ? 'rgba(37, 99, 235, 0.08)' : 'transparent',
                            cursor: 'pointer',
                            textAlign: 'left',
                            transition: 'background 120ms ease',
                            WebkitTapHighlightColor: 'transparent',
                            minHeight: '44px',
                          }}
                        >
                          <span style={{
                            width: '6px',
                            height: '6px',
                            borderRadius: '50%',
                            backgroundColor: sDotColor,
                            flexShrink: 0,
                            boxShadow: isRunning ? `0 0 5px ${sDotColor}` : 'none',
                          }} />
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{
                              fontSize: '13px',
                              fontWeight: isActive ? 600 : 400,
                              color: isActive ? '#2563eb' : '#111827',
                              lineHeight: 1.3,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}>
                              {name}
                            </div>
                            {subtitle ? (
                              <div style={{
                                fontSize: '11px',
                                color: '#8e8e93',
                                lineHeight: 1.3,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                marginTop: '1px',
                              }}>
                                {subtitle}
                              </div>
                            ) : null}
                          </div>
                          {isActive ? (
                            <span style={{ fontSize: '11px', fontWeight: 600, color: '#2563eb', flexShrink: 0 }}>✓</span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                {/* Separator between groups */}
                {group !== projectGroups[projectGroups.length - 1] ? (
                  <div style={{
                    height: '1px',
                    background: 'rgba(15, 23, 42, 0.06)',
                    margin: '4px 12px',
                  }} />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

    </header>
  );
});
