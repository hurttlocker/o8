'use client';

import { memo, useCallback, useMemo } from 'react';
import type { FleetAgent } from './thoughts/types';
import { AgentStatusDot, agentStatusToDotState } from './AgentStatusDot';
import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import { runtimeModelDisplayLabel } from '@/lib/orchestrator/display';

export interface SessionPillContextMenuRequest {
  sessionKey: string;
  sessionName: string;
  isTiled: boolean;
  clientX: number;
  clientY: number;
}

interface SessionVisualizerProps {
  agents: FleetAgent[];
  tiledSessions?: string[];
  onSelectSession?: (sessionKey: string) => void;
  onToggleTileSession?: (sessionKey: string) => void;
  onClearTiles?: () => void;
  /** Right-click on a session pill (issue #663). Receives cursor coordinates
   * so the consumer can render a context menu portal. */
  onRequestContextMenu?: (request: SessionPillContextMenuRequest) => void;
}

export type VisualStatus = 'running' | 'waiting' | 'idle' | 'error';
export type VisualRuntime = 'codex' | 'claude-code' | 'other';

interface VisualSession {
  key: string;
  runtime: VisualRuntime;
  rawRuntime: string | null;
  model: string | null;
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

// VisualRuntime is intentionally narrower than OrchestratorRuntime — it collapses
// gemini/opencode to 'other' for the session strip view. Capability-map lookups use
// optional chaining because 'other' is not a valid OrchestratorRuntime key.
function runtimeLabel(runtime: VisualSession['runtime']): string {
  return ORCHESTRATOR_RUNTIMES[runtime as keyof typeof ORCHESTRATOR_RUNTIMES]?.label ?? 'Agent';
}

function runtimeTint(runtime: VisualSession['runtime']): string {
  return ORCHESTRATOR_RUNTIMES[runtime as keyof typeof ORCHESTRATOR_RUNTIMES]?.accentColor ?? 'var(--t-text-muted)';
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
    rawRuntime: agent.runtime ?? null,
    model: agent.model ?? null,
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

interface SessionPillProps {
  session: VisualSession;
  tiled: boolean;
  onSelectSession?: (sessionKey: string) => void;
  onToggleTileSession?: (sessionKey: string) => void;
  onRequestContextMenu?: (request: SessionPillContextMenuRequest) => void;
}

function SessionPillBase({
  session,
  tiled,
  onSelectSession,
  onToggleTileSession,
  onRequestContextMenu,
}: SessionPillProps) {
  const tint = runtimeTint(session.runtime);

  const handleContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!onRequestContextMenu) return;
    event.preventDefault();
    onRequestContextMenu({
      sessionKey: session.key,
      sessionName: session.name,
      isTiled: tiled,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  }, [onRequestContextMenu, session.key, session.name, tiled]);

  const handleSelect = useCallback(() => {
    onSelectSession?.(session.key);
  }, [onSelectSession, session.key]);

  const handleToggleTile = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onToggleTileSession?.(session.key);
  }, [onToggleTileSession, session.key]);

  const handleWrapperEnter = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.currentTarget.style.borderColor = 'var(--t-accent-border)';
    if (!tiled) event.currentTarget.style.background = 'var(--t-panel-hover)';
  }, [tiled]);

  const handleWrapperLeave = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.currentTarget.style.borderColor = tiled ? 'var(--t-accent-border)' : 'var(--t-divider-subtle)';
    event.currentTarget.style.background = tiled ? 'var(--t-panel)' : 'transparent';
  }, [tiled]);

  const handleToggleEnter = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.style.background = tiled ? 'var(--t-accent-soft)' : 'var(--t-panel)';
    event.currentTarget.style.borderColor = tiled ? 'var(--t-accent-border)' : 'var(--t-border)';
    event.currentTarget.style.color = tiled ? 'var(--t-accent)' : 'var(--t-text)';
  }, [tiled]);

  const handleToggleLeave = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.style.background = tiled ? 'var(--t-accent-soft)' : 'transparent';
    event.currentTarget.style.borderColor = tiled ? 'var(--t-accent-border)' : 'transparent';
    event.currentTarget.style.color = tiled ? 'var(--t-accent)' : 'var(--t-text-secondary)';
  }, [tiled]);

  return (
    <div
      title={`${session.name} — ${runtimeModelDisplayLabel(session.rawRuntime, session.model)} — ${session.headline}`}
      onContextMenu={onRequestContextMenu ? handleContextMenu : undefined}
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
        transition: 'border-color 120ms cubic-bezier(0.22, 1, 0.36, 1), background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      onMouseEnter={handleWrapperEnter}
      onMouseLeave={handleWrapperLeave}
    >
      <button
        type="button"
        onClick={handleSelect}
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
          fontFamily: 'var(--font-sans-system)',
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
          <AgentStatusDot state={agentStatusToDotState(session.status)} />
          <span
            style={{
              fontSize: 9,
              fontWeight: 300,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: tint,
              flexShrink: 0,
            }}
          >
            {runtimeModelDisplayLabel(session.rawRuntime, session.model)}
          </span>
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 400,
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
            fontWeight: 400,
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
        onClick={handleToggleTile}
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
        onMouseEnter={handleToggleEnter}
        onMouseLeave={handleToggleLeave}
      >
        <SplitTileIcon active={tiled} />
      </button>
    </div>
  );
}

const SessionPill = memo(SessionPillBase, (prev, next) => {
  // Identity-stable callback refs from parent are expected (useCallback in
  // use-session-tiles + handleSelectSession). Compare visually-relevant fields.
  if (prev.tiled !== next.tiled) return false;
  if (prev.onSelectSession !== next.onSelectSession) return false;
  if (prev.onToggleTileSession !== next.onToggleTileSession) return false;
  if (prev.onRequestContextMenu !== next.onRequestContextMenu) return false;
  const a = prev.session;
  const b = next.session;
  if (a === b) return true;
  return (
    a.key === b.key
    && a.runtime === b.runtime
    && a.rawRuntime === b.rawRuntime
    && a.model === b.model
    && a.name === b.name
    && a.workspace === b.workspace
    && a.status === b.status
    && a.headline === b.headline
    && a.contextPct === b.contextPct
  );
});

function SessionVisualizerBase({
  agents,
  tiledSessions = [],
  onSelectSession,
  onToggleTileSession,
  onClearTiles,
  onRequestContextMenu,
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
              fontWeight: 300,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--t-text-muted)',
            }}
          >
            Sessions
          </div>
          <div
            style={{
              fontSize: 10,
              fontWeight: 300,
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
                fontWeight: 300,
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
                fontWeight: 400,
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
            fontWeight: 400,
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
          No active sessions. Type a prompt below to spawn one, or dispatch a packet from the orchestrator.
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
          {sessions.map((session) => (
            <SessionPill
              key={session.key}
              session={session}
              tiled={tiledSet.has(session.key)}
              onSelectSession={onSelectSession}
              onToggleTileSession={onToggleTileSession}
              onRequestContextMenu={onRequestContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export const SessionVisualizer = memo(SessionVisualizerBase);

// Re-export the per-session transcript surface so consumers can mount it in
// any tile (issue #663). Implementation lives next to it for cohesion; this
// file is the discoverable home.
export { SessionTranscriptPane } from './SessionTranscriptPane';
