'use client';

import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  isDispatchableRuntime,
  ORCHESTRATOR_RUNTIMES,
} from '@/lib/orchestrator/runtime-capabilities';
import type { SessionSummary } from './types';
import { relativeTimeLabel } from '@/lib/format/relative-time';
import { useTheme } from './ThemeContext';

const SYSTEM_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif';
const ACTIVE_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

interface SessionPickerSheetProps {
  open: boolean;
  sessions: SessionSummary[];
  selectedSessionKey?: string;
  onClose: () => void;
  onSelectSession: (sessionKey: string) => void;
}

interface SessionGroupSet {
  active: SessionSummary[];
  idle: SessionSummary[];
  done: SessionSummary[];
}

function parseTimestamp(value?: string): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isActiveSession(session: SessionSummary): boolean {
  if (
    session.status === 'running'
    || session.status === 'waiting'
    || session.status === 'blocked'
    || session.status === 'reviewing'
  ) {
    return true;
  }

  return session.runtimeSurface?.lifecycle?.availability === 'running';
}

function isDoneSession(session: SessionSummary): boolean {
  if (isActiveSession(session)) {
    return false;
  }

  const outcome = session.runtimeSurface?.lifecycle?.lastOutcome;
  if (outcome === 'finished' || outcome === 'interrupted' || outcome === 'failed') {
    return true;
  }

  return session.status === 'failed' || Boolean(session.currentTask?.trim());
}

function shouldIncludeSession(session: SessionSummary, selectedSessionKey?: string): boolean {
  if (session.sessionKey === selectedSessionKey) {
    return true;
  }

  if (isActiveSession(session)) {
    return true;
  }

  const timestamp = parseTimestamp(session.lastEventAt);
  return timestamp > 0 && (Date.now() - timestamp) <= ACTIVE_SESSION_WINDOW_MS;
}

function compareSessions(
  left: SessionSummary,
  right: SessionSummary,
  selectedSessionKey?: string,
): number {
  const leftSelected = left.sessionKey === selectedSessionKey ? 1 : 0;
  const rightSelected = right.sessionKey === selectedSessionKey ? 1 : 0;
  if (leftSelected !== rightSelected) {
    return rightSelected - leftSelected;
  }

  const timeDiff = parseTimestamp(right.lastEventAt) - parseTimestamp(left.lastEventAt);
  if (timeDiff !== 0) {
    return timeDiff;
  }

  return left.name.localeCompare(right.name);
}

function groupSessions(
  sessions: SessionSummary[],
  selectedSessionKey?: string,
): SessionGroupSet {
  const filtered = sessions
    .filter((session) => shouldIncludeSession(session, selectedSessionKey))
    .sort((left, right) => compareSessions(left, right, selectedSessionKey));

  const active: SessionSummary[] = [];
  const idle: SessionSummary[] = [];
  const done: SessionSummary[] = [];

  for (const session of filtered) {
    if (isActiveSession(session)) {
      active.push(session);
      continue;
    }

    if (isDoneSession(session)) {
      done.push(session);
      continue;
    }

    idle.push(session);
  }

  return { active, idle, done };
}

function formatRelativeTime(value?: string): string {
  const timestamp = parseTimestamp(value);
  if (timestamp <= 0) {
    return 'Unknown';
  }
  return relativeTimeLabel(timestamp, { subMinute: 'just-now-upper' });
}

function RuntimeBadgeIcon({ runtime, size = 16 }: { runtime?: string; size?: number }) {
  if (runtime === 'claude-code') {
    return <img src="/logos/claude.png" alt="Claude" width={size} height={size} style={{ display: 'block', objectFit: 'contain' }} />;
  }
  if (runtime === 'codex') {
    return <img src="/logos/codex.webp" alt="Codex" width={size} height={size} style={{ display: 'block', objectFit: 'contain' }} />;
  }
  const capability = isDispatchableRuntime(runtime) ? ORCHESTRATOR_RUNTIMES[runtime] : null;
  return (
    <span
      aria-label={capability?.label ?? 'Agent runtime'}
      style={{
        color: capability?.accentColor ?? 'var(--t-text-muted)',
        fontSize: 10,
        fontWeight: 800,
        lineHeight: 1,
      }}
    >
      {capability?.shortLabel ?? 'Agent'}
    </span>
  );
}

function statusDotColor(session: SessionSummary): string {
  if (session.status === 'running' || session.status === 'reviewing') {
    return '#30D158';
  }

  if (session.status === 'waiting' || session.status === 'blocked' || session.status === 'failed') {
    return '#FF9F0A';
  }

  return '#706860';
}

function SectionHeader({
  label,
  count,
  collapsible = false,
  open = true,
  onToggle,
}: {
  label: string;
  count: number;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
}) {
  const { colors } = useTheme();

  const content = (
    <>
      <span
        style={{
          color: colors.text,
          fontFamily: SYSTEM_FONT,
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: '-0.01em',
        }}
      >
        {label}
      </span>
      <span
        style={{
          minWidth: 22,
          height: 22,
          padding: '0 7px',
          borderRadius: 999,
          background: colors.surfaceBorder,
          color: colors.textSecondary,
          fontFamily: SYSTEM_FONT,
          fontSize: 12,
          fontWeight: 700,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxSizing: 'border-box',
        }}
      >
        {count}
      </span>
      {collapsible ? (
        <span
          aria-hidden="true"
          style={{
            marginLeft: 'auto',
            width: 18,
            height: 18,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: colors.textSecondary,
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      ) : null}
    </>
  );

  if (!collapsible) {
    return (
      <div
        style={{
          minHeight: 44,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        width: '100%',
        minHeight: 44,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: 0,
        border: 'none',
        background: 'transparent',
        textAlign: 'left',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {content}
    </button>
  );
}

function SessionCard({
  session,
  selected,
  onSelect,
}: {
  session: SessionSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const { colors } = useTheme();

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{
        width: '100%',
        minHeight: 56,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: 14,
        borderRadius: 14,
        border: `1px solid ${colors.surfaceBorder}`,
        background: selected ? 'rgba(46,42,38,0.76)' : 'rgba(46,42,38,0.6)',
        textAlign: 'left',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
        <span
          aria-hidden="true"
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: statusDotColor(session),
            flexShrink: 0,
          }}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span
              style={{
                minWidth: 0,
                color: colors.text,
                fontFamily: SYSTEM_FONT,
                fontSize: 16,
                fontWeight: 700,
                letterSpacing: '-0.02em',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {session.name || 'Agent'}
            </span>
            <span
              style={{
                flexShrink: 0,
                height: 24,
                padding: '0 9px',
                borderRadius: 999,
                background: colors.surfaceBorder,
                color: colors.text,
                fontFamily: SYSTEM_FONT,
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: '0.04em',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <RuntimeBadgeIcon runtime={session.runtime} size={14} />
            </span>
          </div>
          <p
            style={{
              margin: '4px 0 0',
              color: colors.textSecondary,
              fontFamily: SYSTEM_FONT,
              fontSize: 13,
              fontWeight: 500,
              letterSpacing: '-0.01em',
            }}
          >
            {formatRelativeTime(session.lastEventAt)}
          </p>
        </div>
      </div>
      {selected ? (
        <span
          style={{
            flexShrink: 0,
            color: '#0A84FF',
            fontFamily: SYSTEM_FONT,
            fontSize: 13,
            fontWeight: 700,
          }}
        >
          Current
        </span>
      ) : null}
    </button>
  );
}

export const SessionPickerSheet = memo(function SessionPickerSheet({
  open,
  sessions,
  selectedSessionKey,
  onClose,
  onSelectSession,
}: SessionPickerSheetProps) {
  const { colors } = useTheme();
  const [showDone, setShowDone] = useState(false);
  const groupedSessions = useMemo(
    () => groupSessions(sessions, selectedSessionKey),
    [sessions, selectedSessionKey],
  );
  const doneOpen = showDone || groupedSessions.done.some((session) => session.sessionKey === selectedSessionKey);

  useEffect(() => {
    if (!open) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, open]);

  const emptyStateStyle: CSSProperties = {
    margin: 0,
    padding: '18px 14px',
    borderRadius: 14,
    border: `1px solid ${colors.surfaceBorder}`,
    background: 'rgba(46,42,38,0.45)',
    color: colors.textSecondary,
    fontFamily: SYSTEM_FONT,
    fontSize: 14,
    lineHeight: '20px',
  };

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.5)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 220ms cubic-bezier(0.22, 1, 0.36, 1)',
          zIndex: 60,
        }}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Session picker"
        aria-hidden={!open}
        style={{
          position: 'fixed',
          left: '50%',
          right: 'auto',
          bottom: 0,
          width: 'min(100dvw, 430px)',
          maxHeight: '78dvh',
          transform: open ? 'translate(-50%, 0)' : 'translate(-50%, 100%)',
          transition: 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)',
          borderRadius: '20px 20px 0 0',
          background: 'rgba(30,28,26,0.95)',
          backdropFilter: 'blur(40px)',
          WebkitBackdropFilter: 'blur(40px)',
          border: `1px solid ${colors.border}`,
          boxShadow: '0 -20px 48px rgba(0,0,0,0.45)',
          pointerEvents: open ? 'auto' : 'none',
          overflow: 'hidden',
          zIndex: 61,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            padding: '10px 0 4px',
          }}
        >
          <div
            style={{
              width: 36,
              height: 4,
              borderRadius: 2,
              background: 'rgba(255,248,240,0.24)',
            }}
          />
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '8px 20px 14px',
          }}
        >
          <div>
            <h2
              style={{
                margin: 0,
                color: colors.text,
                fontFamily: SYSTEM_FONT,
                fontSize: 20,
                fontWeight: 800,
                letterSpacing: '-0.03em',
              }}
            >
              Sessions
            </h2>
            <p
              style={{
                margin: '4px 0 0',
                color: colors.textSecondary,
                fontFamily: SYSTEM_FONT,
                fontSize: 13,
                fontWeight: 500,
                letterSpacing: '-0.01em',
              }}
            >
              Recent activity only
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              minWidth: 44,
              height: 44,
              padding: '0 14px',
              border: 'none',
              borderRadius: 999,
              background: colors.surfaceBorder,
              color: colors.text,
              fontFamily: SYSTEM_FONT,
              fontSize: 14,
              fontWeight: 700,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            Done
          </button>
        </div>

        <div
          style={{
            display: 'grid',
            gap: 18,
            maxHeight: 'calc(78dvh - 88px)',
            padding: '0 20px calc(20px + env(safe-area-inset-bottom, 0px))',
            overflowY: 'auto',
            WebkitOverflowScrolling: 'touch',
          }}
        >
          <div style={{ display: 'grid', gap: 10 }}>
            <SectionHeader label="Active" count={groupedSessions.active.length} />
            {groupedSessions.active.length > 0 ? (
              groupedSessions.active.map((session) => (
                <SessionCard
                  key={session.sessionKey}
                  session={session}
                  selected={session.sessionKey === selectedSessionKey}
                  onSelect={() => onSelectSession(session.sessionKey)}
                />
              ))
            ) : (
              <p style={emptyStateStyle}>No active sessions right now.</p>
            )}
          </div>

          <div style={{ display: 'grid', gap: 10 }}>
            <SectionHeader label="Idle" count={groupedSessions.idle.length} />
            {groupedSessions.idle.length > 0 ? (
              groupedSessions.idle.map((session) => (
                <SessionCard
                  key={session.sessionKey}
                  session={session}
                  selected={session.sessionKey === selectedSessionKey}
                  onSelect={() => onSelectSession(session.sessionKey)}
                />
              ))
            ) : (
              <p style={emptyStateStyle}>No idle sessions in the last 24 hours.</p>
            )}
          </div>

          {groupedSessions.done.length > 0 ? (
            <div style={{ display: 'grid', gap: 10 }}>
              <SectionHeader
                label="Done"
                count={groupedSessions.done.length}
                collapsible={true}
                open={doneOpen}
                onToggle={() => setShowDone((current) => !current)}
              />
              {doneOpen ? (
                groupedSessions.done.map((session) => (
                  <SessionCard
                    key={session.sessionKey}
                    session={session}
                    selected={session.sessionKey === selectedSessionKey}
                    onSelect={() => onSelectSession(session.sessionKey)}
                  />
                ))
              ) : null}
            </div>
          ) : null}
        </div>
      </section>
    </>
  );
});
