'use client';

import type { CSSProperties } from 'react';
import Link from 'next/link';
import {
  ChevronRight,
  Copy,
  FileDiff,
  Monitor,
  RefreshCw,
  SlidersHorizontal,
  Square,
} from 'lucide-react';
import type { ControlsSheetProps } from './types';
import { useTheme } from './ThemeContext';
import { UniversalSearch } from '@/components/shared/UniversalSearch';

export function ControlsSheet({
  controlsOpen,
  selectedSession,
  pendingApprovals,
  sessionSwitcher,
  reviewFiles,
  surfaceRefreshing,
  isChatSession,
  isOwnedCodexSession,
  canInterruptOwnedCodex,
  compactLine,
  onClose,
  onRefresh,
  onOpenDiff,
  onToggleApprovals,
  onCopyKey,
  onAbort,
  onSessionFocus,
  onSearchSelectSession,
  onSearchSelectIssue,
  children,
}: ControlsSheetProps) {
  const { colors } = useTheme();

  if (!controlsOpen) {
    return null;
  }

  const canAbort = (isChatSession && selectedSession?.status === 'running') || canInterruptOwnedCodex;
  const overlayStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 40,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    padding: '24px 8px max(env(safe-area-inset-bottom, 0px), 8px)',
    background: 'rgba(0,0,0,0.72)',
    backdropFilter: 'blur(18px)',
    WebkitBackdropFilter: 'blur(18px)',
  };
  const sheetStyle: CSSProperties = {
    width: 'min(100%, 420px)',
    maxHeight: 'min(84vh, 760px)',
    display: 'grid',
    gap: 12,
    overflowY: 'auto',
    borderRadius: 14,
    border: `1px solid ${colors.border}`,
    background: 'rgba(28,28,30,0.82)',
    boxShadow: '0 24px 48px rgba(0,0,0,0.34)',
  };
  const headStyle: CSSProperties = {
    position: 'sticky',
    top: 0,
    display: 'grid',
    gap: 10,
    padding: '12px 16px 10px',
    borderBottom: `1px solid ${colors.border}`,
    background: 'rgba(28,28,30,0.92)',
    zIndex: 1,
  };
  const handleStyle: CSSProperties = {
    width: 40,
    height: 5,
    margin: '0 auto',
    borderRadius: 999,
    background: 'rgba(255,255,255,0.14)',
  };
  const titleRowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  };
  const titleStyle: CSSProperties = {
    margin: 0,
    color: colors.text,
    fontSize: 18,
    fontWeight: 700,
    letterSpacing: '-0.02em',
  };
  const doneButtonStyle: CSSProperties = {
    minHeight: 34,
    padding: '0 12px',
    borderRadius: 999,
    border: '1px solid rgba(10,132,255,0.24)',
    background: 'rgba(10,132,255,0.16)',
    color: colors.blueAccent,
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
  };
  const actionListStyle: CSSProperties = {
    display: 'grid',
    gap: 8,
    padding: '0 16px',
  };
  const actionRowStyle = ({
    disabled = false,
    danger = false,
  }: {
    disabled?: boolean;
    danger?: boolean;
  }): CSSProperties => ({
    width: '100%',
    minHeight: 52,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '0 16px',
    borderRadius: 14,
    border: `1px solid ${danger ? 'rgba(255,69,58,0.18)' : colors.border}`,
    background: danger ? 'rgba(255,69,58,0.10)' : 'rgba(44,44,46,0.9)',
    color: danger ? colors.red : colors.text,
    textDecoration: 'none',
    textAlign: 'left',
    opacity: disabled ? 0.45 : 1,
    cursor: disabled ? 'default' : 'pointer',
    WebkitTapHighlightColor: 'transparent',
  });
  const actionIconStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: colors.textSecondary,
    flexShrink: 0,
  };
  const actionLabelStyle: CSSProperties = {
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    fontWeight: 600,
    letterSpacing: '-0.01em',
  };
  const actionBadgeStyle: CSSProperties = {
    minWidth: 22,
    height: 22,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 7px',
    borderRadius: 999,
    background: 'rgba(10,132,255,0.18)',
    color: colors.blueAccent,
    fontSize: 12,
    fontWeight: 700,
  };
  const actionChevronStyle: CSSProperties = {
    color: colors.textTertiary,
    flexShrink: 0,
  };
  const sessionSectionStyle: CSSProperties = {
    display: 'grid',
    gap: 10,
    padding: '4px 16px 16px',
  };
  const sessionLabelStyle: CSSProperties = {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: '0.02em',
  };
  const sessionGridStyle: CSSProperties = {
    display: 'grid',
    gap: 8,
  };
  const sessionRowStyle = (active: boolean): CSSProperties => ({
    width: '100%',
    minHeight: 56,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 14px',
    borderRadius: 14,
    border: `1px solid ${active ? 'rgba(10,132,255,0.24)' : colors.border}`,
    background: active ? 'rgba(10,132,255,0.16)' : 'rgba(44,44,46,0.9)',
    color: colors.text,
    textAlign: 'left',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  });
  const sessionDotStyle = (isLive: boolean): CSSProperties => ({
    width: 10,
    height: 10,
    borderRadius: '50%',
    background: isLive ? colors.green : colors.textTertiary,
    boxShadow: isLive ? '0 0 12px rgba(48,209,88,0.45)' : 'none',
    flexShrink: 0,
  });
  const sessionCopyStyle: CSSProperties = {
    minWidth: 0,
    flex: 1,
    display: 'grid',
    gap: 2,
  };
  const sessionTitleStyle: CSSProperties = {
    color: colors.text,
    fontSize: 14,
    fontWeight: 700,
    letterSpacing: '-0.015em',
  };
  const sessionMetaStyle: CSSProperties = {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: 500,
  };
  const sessionCheckStyle: CSSProperties = {
    color: colors.blueAccent,
    fontSize: 15,
    fontWeight: 700,
    flexShrink: 0,
  };

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" onClick={onClose}>
      <section style={sheetStyle} onClick={(event) => event.stopPropagation()}>
        <div style={headStyle}>
          <div style={handleStyle} />
          <div style={titleRowStyle}>
            <h2 style={titleStyle}>{selectedSession?.isCurrentSession ? 'Q ↔ Mister' : compactLine(selectedSession?.name, 'Session', 24)}</h2>
            <button type="button" style={doneButtonStyle} onClick={onClose}>
              Done
            </button>
          </div>
        </div>

        {/* Universal Search */}
        <div style={{ padding: '0 16px 8px' }}>
          <UniversalSearch
            variant="mobile"
            onSelectSession={(sessionKey) => {
              if (onSearchSelectSession) onSearchSelectSession(sessionKey);
              onClose();
            }}
            onSelectIssue={(num) => {
              if (onSearchSelectIssue) onSearchSelectIssue(num);
              onClose();
            }}
            onSelectFile={() => {
              // File viewing not wired on mobile yet — close menu
              onClose();
            }}
            onClose={onClose}
          />
        </div>

        <div style={actionListStyle}>
          <button
            type="button"
            style={actionRowStyle({})}
            onClick={() => {
              void onRefresh();
              onClose();
            }}
          >
            <span style={actionIconStyle}><RefreshCw size={18} strokeWidth={1.8} style={surfaceRefreshing ? { animation: 'spin 1s linear infinite' } : undefined} /></span>
            <span style={actionLabelStyle}>Refresh</span>
          </button>
          <button type="button" style={actionRowStyle({ disabled: !reviewFiles.length })} onClick={onOpenDiff} disabled={!reviewFiles.length}>
            <span style={actionIconStyle}><FileDiff size={18} strokeWidth={1.8} /></span>
            <span style={actionLabelStyle}>Changes</span>
            {reviewFiles.length ? <span style={actionBadgeStyle}>{reviewFiles.length}</span> : null}
          </button>
          <button
            type="button"
            style={actionRowStyle({ disabled: !selectedSession })}
            disabled={!selectedSession}
            onClick={() => {
              onCopyKey();
              onClose();
            }}
          >
            <span style={actionIconStyle}><Copy size={18} strokeWidth={1.8} /></span>
            <span style={actionLabelStyle}>Copy session key</span>
          </button>
          <button
            type="button"
            style={actionRowStyle({})}
            onClick={() => {
              onToggleApprovals();
              onClose();
            }}
          >
            <span style={actionIconStyle}><SlidersHorizontal size={18} strokeWidth={1.8} /></span>
            <span style={actionLabelStyle}>Open approval queue</span>
            {pendingApprovals.length ? <span style={actionBadgeStyle}>{pendingApprovals.length}</span> : null}
          </button>
          <Link href="/" style={actionRowStyle({})} onClick={onClose}>
            <span style={actionIconStyle}><Monitor size={18} strokeWidth={1.8} /></span>
            <span style={actionLabelStyle}>Open on desktop</span>
            <ChevronRight size={16} strokeWidth={1.8} style={actionChevronStyle} />
          </Link>
          {canAbort ? (
            <button
              type="button"
              style={actionRowStyle({ danger: true })}
              onClick={() => {
                void onAbort();
              }}
            >
              <span style={{ ...actionIconStyle, color: colors.red }}><Square size={18} strokeWidth={1.8} /></span>
              <span style={actionLabelStyle}>{isOwnedCodexSession ? 'Interrupt run' : 'Stop run'}</span>
            </button>
          ) : null}
        </div>

        {/* Cortex Memory status card (passed as children) */}
        {children ? <div style={{ padding: '0 16px', marginTop: 12, marginBottom: 4 }}>{children}</div> : null}

        {sessionSwitcher.length > 1 ? (
          <div style={sessionSectionStyle}>
            <span style={sessionLabelStyle}>Sessions</span>
            <div style={sessionGridStyle}>
              {(() => {
                const nameCount = new Map<string, number>();
                const nameIndex = new Map<string, number>();
                for (const session of sessionSwitcher) {
                  nameCount.set(session.name, (nameCount.get(session.name) ?? 0) + 1);
                }
                return sessionSwitcher.map((session) => {
                  const count = nameCount.get(session.name) ?? 1;
                  const index = (nameIndex.get(session.name) ?? 0) + 1;
                  nameIndex.set(session.name, index);
                  const displayName = session.isCurrentSession
                    ? 'Q ↔ Mister'
                    : count > 1
                      ? `${compactLine(session.name, session.name, 24)} #${index}`
                      : compactLine(session.name, session.name, 32);
                  const active = session.id === selectedSession?.id;
                  const isLive = session.status === 'running' || session.status === 'reviewing';
                  return (
                    <button
                      key={session.id}
                      type="button"
                      style={sessionRowStyle(active)}
                      onClick={() => onSessionFocus(session.id)}
                    >
                      <span style={sessionDotStyle(isLive)} />
                      <span style={sessionCopyStyle}>
                        <strong style={sessionTitleStyle}>{displayName}</strong>
                        <span style={sessionMetaStyle}>{session.status} · {compactLine(session.lastEventAt, 'now', 20)}</span>
                      </span>
                      {active ? <span style={sessionCheckStyle}>✓</span> : null}
                    </button>
                  );
                });
              })()}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
