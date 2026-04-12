'use client';

/**
 * SessionVisualizer — horizontal strip of active agent sessions.
 *
 * First pass ("try some stuff"). Sits at the top of the orchestrator tile,
 * above the chat body. Shows one card per active fleet agent with:
 *   - Runtime badge (codex / claude-code)
 *   - Workspace / branch label
 *   - Status dot (running / idle / waiting / error)
 *   - Headline of the current activity
 *
 * Empty state nudges the user to spawn a session via the chat composer below.
 *
 * This is a visual scaffold — click handlers are stubbed. The goal is to
 * get something on screen that reads as "here are my agents right now"
 * so we can iterate on density, affordances, and interactions.
 */

import { memo, useMemo } from 'react';
import type { FleetAgent } from './thoughts/types';

interface SessionVisualizerProps {
  agents: FleetAgent[];
  onSelectSession?: (sessionKey: string) => void;
}

type VisualStatus = 'running' | 'waiting' | 'idle' | 'error';

interface VisualSession {
  key: string;
  runtime: 'codex' | 'claude-code' | 'other';
  name: string;
  workspace: string | null;
  status: VisualStatus;
  headline: string;
  contextPct: number | null;
}

const STATUS_COLORS: Record<VisualStatus, string> = {
  running: '#22c55e',
  waiting: '#f59e0b',
  idle: '#64748b',
  error: '#ef4444',
};

const STATUS_LABELS: Record<VisualStatus, string> = {
  running: 'Running',
  waiting: 'Waiting',
  idle: 'Idle',
  error: 'Error',
};

function classifyStatus(rawStatus: string | undefined): VisualStatus {
  const s = (rawStatus ?? '').toLowerCase();
  if (s.includes('error') || s.includes('fail')) return 'error';
  if (s.includes('wait') || s.includes('approval') || s.includes('pending')) return 'waiting';
  if (s.includes('running') || s.includes('active') || s.includes('working')) return 'running';
  return 'idle';
}

function classifyRuntime(raw: string | undefined): VisualSession['runtime'] {
  const r = (raw ?? '').toLowerCase();
  if (r.includes('claude')) return 'claude-code';
  if (r.includes('codex')) return 'codex';
  return 'other';
}

function runtimeLabel(runtime: VisualSession['runtime']): string {
  if (runtime === 'claude-code') return 'Claude Code';
  if (runtime === 'codex') return 'Codex';
  return 'Agent';
}

function runtimeTint(runtime: VisualSession['runtime']): string {
  if (runtime === 'claude-code') return '#c86b2b';
  if (runtime === 'codex') return '#8b5cf6';
  return 'var(--t-text-muted)';
}

function workspaceLabel(workspace: string | undefined | null): string | null {
  if (!workspace) return null;
  const parts = workspace.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : workspace;
}

function toVisualSession(agent: FleetAgent, index: number): VisualSession {
  const runtime = classifyRuntime(agent.runtime);
  const key = agent.sessionKey ?? `${runtime}-${index}`;
  return {
    key,
    runtime,
    name: agent.name?.trim() || runtimeLabel(runtime),
    workspace: workspaceLabel(agent.workspace),
    status: classifyStatus(agent.status),
    headline: agent.activity?.headline?.trim() || agent.currentTask?.trim() || 'No activity',
    contextPct: typeof agent.context?.usedPercent === 'number' ? agent.context.usedPercent : null,
  };
}

function SessionVisualizerBase({ agents, onSelectSession }: SessionVisualizerProps) {
  const sessions = useMemo(() => agents.map(toVisualSession), [agents]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        paddingTop: 10,
        paddingRight: 14,
        paddingBottom: 10,
        paddingLeft: 14,
        borderBottomWidth: '0.5px',
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
        background: 'var(--t-chat-surface-bg, #ffffff)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--t-text-muted)',
          }}
        >
          Sessions
        </div>
        <div
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--t-text-faint)',
          }}
        >
          {sessions.length === 0
            ? 'None active'
            : `${sessions.length} ${sessions.length === 1 ? 'agent' : 'agents'}`}
        </div>
      </div>

      {sessions.length === 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            height: 56,
            paddingLeft: 12,
            paddingRight: 12,
            borderRadius: 10,
            borderWidth: 1,
            borderStyle: 'dashed',
            borderColor: 'var(--t-divider-subtle)',
            background: 'transparent',
            fontSize: 11,
            fontWeight: 500,
            color: 'var(--t-text-muted)',
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: 'var(--t-text-faint)',
              flexShrink: 0,
            }}
          />
          No active sessions. Type a prompt below to spawn one, or dispatch from Mission Control.
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            gap: 8,
            overflowX: 'auto',
            overflowY: 'hidden',
            paddingBottom: 2,
            scrollbarWidth: 'thin',
          } as React.CSSProperties}
        >
          {sessions.map((session) => {
            const statusColor = STATUS_COLORS[session.status];
            const tint = runtimeTint(session.runtime);
            return (
              <button
                key={session.key}
                type="button"
                onClick={() => onSelectSession?.(session.key)}
                title={`${session.name} — ${session.headline}`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 5,
                  minWidth: 180,
                  maxWidth: 240,
                  paddingTop: 9,
                  paddingRight: 12,
                  paddingBottom: 9,
                  paddingLeft: 12,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'var(--t-divider-subtle)',
                  background: 'var(--t-bg-card)',
                  color: 'var(--t-text)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  flexShrink: 0,
                  transition: 'border-color 120ms ease, background 120ms ease',
                  fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--t-accent-border)';
                  e.currentTarget.style.background = 'var(--t-panel-hover)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--t-divider-subtle)';
                  e.currentTarget.style.background = 'var(--t-bg-card)';
                }}
              >
                {/* Row 1: runtime + status */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 6,
                  }}
                >
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      fontSize: 9.5,
                      fontWeight: 700,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      color: tint,
                    }}
                  >
                    <span
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: '50%',
                        background: tint,
                      }}
                    />
                    {runtimeLabel(session.runtime)}
                  </span>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 9,
                      fontWeight: 600,
                      color: statusColor,
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: statusColor,
                        boxShadow: session.status === 'running'
                          ? `0 0 0 3px ${statusColor}22`
                          : 'none',
                      }}
                    />
                    {STATUS_LABELS[session.status]}
                  </span>
                </div>

                {/* Row 2: name / workspace */}
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--t-text)',
                    letterSpacing: '-0.01em',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {session.name}
                  {session.workspace ? (
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 10.5,
                        fontWeight: 500,
                        color: 'var(--t-text-muted)',
                      }}
                    >
                      · {session.workspace}
                    </span>
                  ) : null}
                </div>

                {/* Row 3: headline */}
                <div
                  style={{
                    fontSize: 10.5,
                    fontWeight: 500,
                    color: 'var(--t-text-muted)',
                    lineHeight: 1.35,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {session.headline}
                </div>

                {/* Optional row 4: context bar */}
                {session.contextPct !== null ? (
                  <div
                    style={{
                      marginTop: 2,
                      height: 3,
                      borderRadius: 2,
                      background: 'var(--t-divider-subtle)',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${Math.min(100, Math.max(0, session.contextPct))}%`,
                        height: '100%',
                        background: session.contextPct > 85
                          ? '#ef4444'
                          : session.contextPct > 65
                            ? '#f59e0b'
                            : 'var(--t-accent)',
                      }}
                    />
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const SessionVisualizer = memo(SessionVisualizerBase);
