'use client';

import type { CSSProperties } from 'react';
import type { AgentDisplayName, CompactLine, SessionSummary } from './types';
import { useTheme } from './ThemeContext';

interface RecentSessionPickerProps {
  sessions: SessionSummary[];
  compactLine: CompactLine;
  agentDisplayName: AgentDisplayName;
  onSessionSelect: (sessionId: string) => void;
  onLaunch: () => void;
}

interface SessionAgentPillProps {
  session: SessionSummary;
  compactLine: CompactLine;
  agentDisplayName: AgentDisplayName;
  onClick: () => void;
}

function statusLabel(session: SessionSummary) {
  if (session.isCurrentSession) return 'Live';
  if (session.runtimeSurface?.lifecycle?.availability === 'running') return 'Running';
  return session.status.charAt(0).toUpperCase() + session.status.slice(1);
}

function statusColor(session: SessionSummary, accent: string) {
  if (session.isCurrentSession || session.runtimeSurface?.lifecycle?.availability === 'running' || session.status === 'running') {
    return accent;
  }
  if (session.status === 'failed' || session.status === 'blocked') {
    return '#FF453A';
  }
  return '#8E8E93';
}

function ChevronDownIcon({ color }: { color: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function ArrowIcon({ color }: { color: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 17 17 7" />
      <path d="M9 7h8v8" />
    </svg>
  );
}

export function SessionAgentPill({
  session,
  compactLine,
  agentDisplayName,
  onClick,
}: SessionAgentPillProps) {
  const { colors } = useTheme();

  const buttonStyle: CSSProperties = {
    width: 'calc(100% - 28px)',
    margin: 'calc(env(safe-area-inset-top, 0px) + 68px) 14px 12px',
    padding: '12px 14px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderRadius: 14,
    border: `1px solid ${colors.cardBorder}`,
    background: colors.cardBg,
    color: colors.text,
    boxShadow: '0 14px 30px rgba(0,0,0,0.28)',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    WebkitTapHighlightColor: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
  };

  return (
    <button type="button" onClick={onClick} style={buttonStyle}>
      <span style={{ minWidth: 0, display: 'grid', gap: 4 }}>
        <span
          style={{
            color: colors.textSecondary,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          Active agent
        </span>
        <span
          style={{
            color: colors.text,
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {compactLine(session.name, agentDisplayName(session), 34)}
        </span>
      </span>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          color: colors.textSecondary,
          fontSize: 12,
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        <span>{compactLine(session.lastEventAt, 'now', 12)}</span>
        <ChevronDownIcon color={colors.textSecondary} />
      </span>
    </button>
  );
}

export function RecentSessionPicker({
  sessions,
  compactLine,
  agentDisplayName,
  onSessionSelect,
  onLaunch,
}: RecentSessionPickerProps) {
  const { colors } = useTheme();
  const visibleSessions = sessions.slice(0, 5);

  const shellStyle: CSSProperties = {
    paddingTop: 'calc(env(safe-area-inset-top, 0px) + 76px)',
    paddingRight: 14,
    paddingBottom: 24,
    paddingLeft: 14,
  };

  const introCardStyle: CSSProperties = {
    padding: '18px 18px 16px',
    borderRadius: 14,
    border: `1px solid ${colors.cardBorder}`,
    background: colors.cardBg,
    boxShadow: '0 14px 28px rgba(0,0,0,0.24)',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
  };

  const launchButtonStyle: CSSProperties = {
    width: '100%',
    minHeight: 52,
    padding: '14px 16px',
    borderRadius: 14,
    border: '1px solid rgba(10,132,255,0.24)',
    background: colors.blueAccent,
    color: colors.text,
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: '-0.02em',
    boxShadow: '0 14px 28px rgba(10,132,255,0.28)',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  };

  return (
    <section style={shellStyle}>
      <div style={{ display: 'grid', gap: 12 }}>
        <div style={introCardStyle}>
          <p
            style={{
              margin: 0,
              color: colors.textSecondary,
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            Recent sessions
          </p>
          <h2
            style={{
              margin: '8px 0 0',
              color: colors.text,
              fontSize: 24,
              fontWeight: 800,
              letterSpacing: '-0.04em',
            }}
          >
            Pick a thread
          </h2>
          <p
            style={{
              margin: '8px 0 0',
              color: colors.textSecondary,
              fontSize: 14,
              lineHeight: 1.5,
            }}
          >
            Chat opens first when a session is active. Right now there is no active mobile thread, so choose a recent session or launch a fresh one.
          </p>
        </div>

        {visibleSessions.length ? visibleSessions.map((session, index) => {
          const accent = statusColor(session, colors.blueAccent);
          return (
            <button
              key={session.id}
              type="button"
              onClick={() => onSessionSelect(session.id)}
              style={{
                width: '100%',
                padding: '16px 16px 15px',
                display: 'grid',
                gap: 12,
                borderRadius: 14,
                border: `1px solid ${index === 0 ? 'rgba(10,132,255,0.22)' : colors.cardBorder}`,
                background: colors.cardBg,
                color: colors.text,
                boxShadow: index === 0
                  ? '0 16px 32px rgba(10,132,255,0.12)'
                  : '0 14px 28px rgba(0,0,0,0.24)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                textAlign: 'left',
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    minWidth: 0,
                    color: colors.textSecondary,
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: '0.02em',
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: accent,
                      boxShadow: `0 0 0 4px ${accent}22`,
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {compactLine(session.name, agentDisplayName(session), 30)}
                  </span>
                </span>
                <span
                  style={{
                    padding: '6px 10px',
                    borderRadius: 999,
                    border: `1px solid ${colors.cardBorder}`,
                    background: 'rgba(255,255,255,0.04)',
                    color: accent,
                    fontSize: 11,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {statusLabel(session)}
                </span>
              </span>

              <span
                style={{
                  color: colors.text,
                  fontSize: 18,
                  fontWeight: 700,
                  letterSpacing: '-0.03em',
                  lineHeight: 1.3,
                }}
              >
                {compactLine(session.currentTask ?? session.name, session.name ?? session.sessionKey, 88)}
              </span>

              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <span
                  style={{
                    color: colors.textSecondary,
                    fontSize: 13,
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {compactLine(session.workspace, session.branch || session.runtime, 40)}
                </span>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    color: colors.textSecondary,
                    fontSize: 12,
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                >
                  <span>{compactLine(session.lastEventAt, 'now', 16)}</span>
                  <ArrowIcon color={colors.textSecondary} />
                </span>
              </span>
            </button>
          );
        }) : (
          <div
            style={{
              padding: '18px 16px',
              borderRadius: 14,
              border: `1px solid ${colors.cardBorder}`,
              background: colors.cardBg,
              color: colors.textSecondary,
              fontSize: 14,
              lineHeight: 1.5,
              boxShadow: '0 14px 28px rgba(0,0,0,0.24)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
            }}
          >
            No recent sessions are available yet.
          </div>
        )}

        <button type="button" onClick={onLaunch} style={launchButtonStyle}>
          Launch new remote session
        </button>
      </div>
    </section>
  );
}
