'use client';

import { memo, useMemo } from 'react';
import type { FleetAgent } from './thoughts/types';

interface SessionVisualizerProps {
  agents: FleetAgent[];
  tiledSessions?: string[];
  onSelectSession?: (sessionKey: string) => void;
  onToggleTileSession?: (sessionKey: string) => void;
  onClearTiles?: () => void;
}

export type VisualStatus = 'running' | 'waiting' | 'idle' | 'error';
export type VisualRuntime = 'codex' | 'claude-code' | 'other';

interface VisualSession {
  key: string;
  runtime: VisualRuntime;
  name: string;
  workspace: string | null;
  status: VisualStatus;
  headline: string;
  contextPct: number | null;
}

export const STATUS_COLORS: Record<VisualStatus, string> = {
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

export function classifyStatus(rawStatus: string | undefined): VisualStatus {
  const value = (rawStatus ?? '').toLowerCase();
  if (value.includes('error') || value.includes('fail')) return 'error';
  if (value.includes('wait') || value.includes('approval') || value.includes('pending')) return 'waiting';
  if (value.includes('running') || value.includes('active') || value.includes('working')) return 'running';
  return 'idle';
}

export function classifyRuntime(rawRuntime: string | undefined): VisualRuntime {
  const value = (rawRuntime ?? '').toLowerCase();
  if (value.includes('claude')) return 'claude-code';
  if (value.includes('codex')) return 'codex';
  return 'other';
}

function runtimeLabel(runtime: VisualSession['runtime']): string {
  if (runtime === 'claude-code') return 'Claude Code';
  if (runtime === 'codex') return 'Codex';
  return 'Agent';
}

function runtimeTint(runtime: VisualSession['runtime']): string {
  if (runtime === 'claude-code') return '#c86b2b';
  if (runtime === 'codex') return '#2563eb';
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

function SplitTileIcon({
  active,
}: {
  active: boolean;
}) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="5" width="7" height="14" rx="2.2" />
      <rect x="13.5" y="5" width="7" height="14" rx="2.2" />
      {active ? (
        <>
          <path d="M8.1 8.1l2 2" />
          <path d="M10.1 8.1l-2 2" />
        </>
      ) : null}
    </svg>
  );
}

function SessionVisualizerBase({
  agents,
  tiledSessions = [],
  onSelectSession,
  onToggleTileSession,
  onClearTiles,
}: SessionVisualizerProps) {
  const sessions = useMemo(() => agents.map(toVisualSession), [agents]);
  const tiledSet = useMemo(() => new Set(tiledSessions), [tiledSessions]);
  const showClearTiles = tiledSessions.length > 1;

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
          gap: 12,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            minWidth: 0,
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
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexShrink: 0,
          }}
        >
          {tiledSessions.length > 0 ? (
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: 'var(--t-text-faint)',
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
              }}
            >
              {`${tiledSessions.length} tiled`}
            </div>
          ) : null}
          {showClearTiles ? (
            <button
              type="button"
              onClick={onClearTiles}
              style={{
                minWidth: 96,
                height: 44,
                paddingTop: 0,
                paddingRight: 14,
                paddingBottom: 0,
                paddingLeft: 14,
                borderRadius: 12,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-border)',
                background: 'var(--t-bg-card)',
                color: 'var(--t-text-secondary)',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.borderColor = 'var(--t-border-hover, var(--t-accent-border))';
                event.currentTarget.style.background = 'var(--t-panel)';
                event.currentTarget.style.color = 'var(--t-text)';
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.borderColor = 'var(--t-border)';
                event.currentTarget.style.background = 'var(--t-bg-card)';
                event.currentTarget.style.color = 'var(--t-text-secondary)';
              }}
            >
              Clear tiles
            </button>
          ) : null}
        </div>
      </div>

      {sessions.length === 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            minHeight: 56,
            paddingTop: 0,
            paddingRight: 12,
            paddingBottom: 0,
            paddingLeft: 12,
            borderRadius: 14,
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
            paddingTop: 2,
            paddingRight: 0,
            paddingBottom: 2,
            paddingLeft: 0,
            scrollbarWidth: 'thin',
          }}
        >
          {sessions.map((session) => {
            const statusColor = STATUS_COLORS[session.status];
            const tint = runtimeTint(session.runtime);
            const tiled = tiledSet.has(session.key);

            return (
              <div
                key={session.key}
                title={`${session.name} — ${session.headline}`}
                style={{
                  position: 'relative',
                  minWidth: 148,
                  maxWidth: 188,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: tiled ? 'var(--t-accent-border)' : 'var(--t-divider-subtle)',
                  background: tiled ? 'var(--t-panel)' : 'transparent',
                  color: 'var(--t-text)',
                  flexShrink: 0,
                  boxShadow: 'none',
                  transition: 'border-color 120ms ease, background 120ms ease',
                }}
                onMouseEnter={(event) => {
                  event.currentTarget.style.borderColor = 'var(--t-accent-border)';
                  if (!tiled) event.currentTarget.style.background = 'var(--t-panel-hover)';
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.borderColor = tiled ? 'var(--t-accent-border)' : 'var(--t-divider-subtle)';
                  event.currentTarget.style.background = tiled ? 'var(--t-panel)' : 'transparent';
                }}
              >
                <button
                  type="button"
                  onClick={() => onSelectSession?.(session.key)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                    paddingTop: 6,
                    paddingRight: 32,
                    paddingBottom: 6,
                    paddingLeft: 8,
                    borderRadius: 8,
                    borderWidth: 0,
                    background: 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      minWidth: 0,
                    }}
                  >
                    <span
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: '50%',
                        background: statusColor,
                        flexShrink: 0,
                        boxShadow: session.status === 'running' ? `0 0 0 2px ${statusColor}22` : 'none',
                      }}
                    />
                    <span
                      style={{
                        fontSize: 9,
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        color: tint,
                        flexShrink: 0,
                      }}
                    >
                      {runtimeLabel(session.runtime)}
                    </span>
                    <span
                      style={{
                        fontSize: 10.5,
                        fontWeight: 500,
                        color: 'var(--t-text-muted)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        minWidth: 0,
                      }}
                    >
                      {session.workspace ?? session.name}
                    </span>
                  </div>

                  <div
                    style={{
                      fontSize: 10.5,
                      fontWeight: 500,
                      color: 'var(--t-text-muted)',
                      lineHeight: 1.3,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {session.headline}
                  </div>

                  {session.contextPct !== null ? (
                    <div
                      style={{
                        marginTop: 1,
                        height: 2,
                        borderRadius: 1,
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

                <button
                  type="button"
                  aria-label={tiled ? `Remove ${session.name} from tiled view` : `Add ${session.name} to tiled view`}
                  title={tiled ? 'Remove from tiled view' : 'Add to tiled view'}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleTileSession?.(session.key);
                  }}
                  style={{
                    position: 'absolute',
                    top: 4,
                    right: 4,
                    width: 22,
                    height: 22,
                    borderRadius: 6,
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: tiled ? 'var(--t-accent-border)' : 'transparent',
                    background: tiled ? 'var(--t-accent-soft)' : 'transparent',
                    color: tiled ? 'var(--t-accent)' : 'var(--t-text-faint)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(event) => {
                    event.currentTarget.style.background = tiled ? 'var(--t-accent-soft)' : 'var(--t-panel)';
                    event.currentTarget.style.borderColor = tiled ? 'var(--t-accent-border)' : 'var(--t-border)';
                    event.currentTarget.style.color = tiled ? 'var(--t-accent)' : 'var(--t-text)';
                  }}
                  onMouseLeave={(event) => {
                    event.currentTarget.style.background = tiled ? 'var(--t-accent-soft)' : 'transparent';
                    event.currentTarget.style.borderColor = tiled ? 'var(--t-accent-border)' : 'transparent';
                    event.currentTarget.style.color = tiled ? 'var(--t-accent)' : 'var(--t-text-secondary)';
                  }}
                >
                  <SplitTileIcon active={tiled} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const SessionVisualizer = memo(SessionVisualizerBase);
