'use client';

import { memo, useEffect, useState } from 'react';
import { STATUS_COLORS, classifyRuntime, classifyStatus, type VisualRuntime, type VisualStatus } from './SessionVisualizer';
import type { FleetAgent } from './thoughts/types';

interface UnifiedAgentsSidebarProps {
  agents: FleetAgent[];
  open: boolean;
  onClose: () => void;
  onSelectSession?: (sessionKey: string) => void;
}

interface UnifiedAgentRow {
  key: string;
  sessionKey: string | null;
  source: VisualRuntime;
  status: VisualStatus;
  name: string;
  headline: string;
  lastEventAt: string | null;
  model: string | null;
}

interface UnifiedAgentGroup {
  key: VisualRuntime;
  label: string;
  items: UnifiedAgentRow[];
}

const SIDEBAR_TRANSITION = 'width 220ms cubic-bezier(0.22, 1, 0.36, 1), min-width 220ms cubic-bezier(0.22, 1, 0.36, 1)';
const USERS_THREE_ICON_PATH = 'M244.8,150.4a8,8,0,0,1-11.2-1.6A51.6,51.6,0,0,0,192,128a8,8,0,0,1-7.37-4.89,8,8,0,0,1,0-6.22A8,8,0,0,1,192,112a24,24,0,1,0-23.24-30,8,8,0,1,1-15.5-4A40,40,0,1,1,219,117.51a67.94,67.94,0,0,1,27.43,21.68A8,8,0,0,1,244.8,150.4ZM190.92,212a8,8,0,1,1-13.84,8,57,57,0,0,0-98.16,0,8,8,0,1,1-13.84-8,72.06,72.06,0,0,1,33.74-29.92,48,48,0,1,1,58.36,0A72.06,72.06,0,0,1,190.92,212ZM128,176a32,32,0,1,0-32-32A32,32,0,0,0,128,176ZM72,120a8,8,0,0,0-8-8A24,24,0,1,1,87.24,82a8,8,0,1,0,15.5-4A40,40,0,1,0,37,117.51,67.94,67.94,0,0,0,9.6,139.19a8,8,0,1,0,12.8,9.61A51.6,51.6,0,0,1,64,128,8,8,0,0,0,72,120Z';

const GROUP_LABELS: Record<VisualRuntime, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  other: 'Other/MCP',
};

function runtimeFallbackLabel(source: VisualRuntime): string {
  if (source === 'claude-code') return 'Claude Code';
  if (source === 'codex') return 'Codex';
  return 'Agent';
}

function mapAgent(agent: FleetAgent, index: number): UnifiedAgentRow {
  const source = classifyRuntime(agent.runtime);
  const name = agent.name?.trim() || runtimeFallbackLabel(source);
  const headline = agent.activity?.headline?.trim() || agent.currentTask?.trim() || 'No active task';
  const model = agent.model?.trim() || null;
  return {
    key: agent.sessionKey ?? `${source}-${index}`,
    sessionKey: agent.sessionKey ?? null,
    source,
    status: classifyStatus(agent.status),
    name,
    headline,
    lastEventAt: agent.lastEventAt ?? null,
    model,
  };
}

function activityTimestamp(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortAgents(a: UnifiedAgentRow, b: UnifiedAgentRow): number {
  const byActivity = activityTimestamp(b.lastEventAt) - activityTimestamp(a.lastEventAt);
  if (byActivity !== 0) return byActivity;
  return a.name.localeCompare(b.name);
}

function buildGroups(agents: FleetAgent[]): UnifiedAgentGroup[] {
  const bucketed = new Map<VisualRuntime, UnifiedAgentRow[]>([
    ['codex', []],
    ['claude-code', []],
    ['other', []],
  ]);

  agents.map(mapAgent).sort(sortAgents).forEach((agent) => {
    bucketed.get(agent.source)?.push(agent);
  });

  return (['codex', 'claude-code', 'other'] as const)
    .map((key) => ({
      key,
      label: GROUP_LABELS[key],
      items: bucketed.get(key) ?? [],
    }))
    .filter((group) => group.items.length > 0);
}

function formatRelativeTime(value: string | null, now: number): string {
  const ts = activityTimestamp(value);
  if (!ts) return 'No activity';
  const diffMs = now - ts;
  const diffSeconds = Math.max(0, Math.floor(diffMs / 1000));
  if (diffSeconds < 10) return 'just now';
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function UsersThreeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <path d={USERS_THREE_ICON_PATH} fill="currentColor" />
    </svg>
  );
}

function PanelLeftCloseIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }} aria-hidden="true">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="m16 15-3-3 3-3" />
    </svg>
  );
}

function UnifiedAgentsSidebarBase({
  agents,
  open,
  onClose,
  onSelectSession,
}: UnifiedAgentsSidebarProps) {
  const [, setLifecycleTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const handleLifecycle = () => {
      setLifecycleTick((current) => current + 1);
      setNow(Date.now());
    };

    window.addEventListener('o8:lane-lifecycle', handleLifecycle);
    window.addEventListener('o8:agent-lifecycle', handleLifecycle);
    return () => {
      window.removeEventListener('o8:lane-lifecycle', handleLifecycle);
      window.removeEventListener('o8:agent-lifecycle', handleLifecycle);
    };
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, [open]);

  const groups = buildGroups(agents);
  const totalAgents = groups.reduce((count, group) => count + group.items.length, 0);

  return (
    <div
      style={{
        width: open ? 280 : 0,
        minWidth: open ? 280 : 0,
        borderRightWidth: open ? 1 : 0,
        borderRightStyle: 'solid',
        borderRightColor: 'var(--t-divider-subtle)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: SIDEBAR_TRANSITION,
        background: 'var(--t-chat-surface-bg, #ffffff)',
        flexShrink: 0,
      }}
    >
      {open ? (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              paddingTop: 12,
              paddingRight: 10,
              paddingBottom: 12,
              paddingLeft: 14,
              borderBottomWidth: 1,
              borderBottomStyle: 'solid',
              borderBottomColor: 'var(--t-divider-subtle)',
              flexShrink: 0,
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
                  width: 28,
                  height: 28,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'var(--t-border)',
                  background: 'var(--t-panel)',
                  color: 'var(--t-accent)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <UsersThreeIcon size={15} />
              </div>
              <div
                style={{
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: 'var(--t-text)',
                    letterSpacing: '-0.01em',
                  }}
                >
                  Agents
                </span>
                <span
                  style={{
                    fontSize: 10.5,
                    fontWeight: 500,
                    color: 'var(--t-text-secondary)',
                  }}
                >
                  {totalAgents === 0
                    ? 'No live sessions'
                    : `${totalAgents} live ${totalAgents === 1 ? 'agent' : 'agents'}`}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              title="Hide agents"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 24,
                height: 24,
                borderWidth: 0,
                borderRadius: 6,
                background: 'transparent',
                color: 'var(--t-text-muted)',
                cursor: 'pointer',
                flexShrink: 0,
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = 'var(--t-panel)';
                event.currentTarget.style.color = 'var(--t-text)';
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = 'transparent';
                event.currentTarget.style.color = 'var(--t-text-muted)';
              }}
            >
              <PanelLeftCloseIcon size={13} />
            </button>
          </div>

          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              paddingTop: 8,
              paddingRight: 0,
              paddingBottom: 12,
              paddingLeft: 0,
            }}
          >
            {groups.length === 0 ? (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  paddingTop: 28,
                  paddingRight: 18,
                  paddingBottom: 28,
                  paddingLeft: 18,
                }}
              >
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 14,
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: 'var(--t-border)',
                    background: 'var(--t-panel)',
                    color: 'var(--t-text-secondary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <UsersThreeIcon size={18} />
                </div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--t-text)',
                    letterSpacing: '-0.01em',
                  }}
                >
                  No live agents
                </div>
                <div
                  style={{
                    fontSize: 11,
                    lineHeight: 1.5,
                    color: 'var(--t-text-secondary)',
                    textAlign: 'center',
                    maxWidth: 220,
                  }}
                >
                  Codex, Claude Code, and other runtime lanes will appear here as soon as they start work.
                </div>
              </div>
            ) : (
              groups.map((group) => (
                <div key={group.key}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      paddingTop: 10,
                      paddingRight: 14,
                      paddingBottom: 6,
                      paddingLeft: 14,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        color: 'var(--t-text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                      }}
                    >
                      {group.label}
                    </span>
                    <span
                      style={{
                        minWidth: 22,
                        height: 22,
                        paddingTop: 0,
                        paddingRight: 8,
                        paddingBottom: 0,
                        paddingLeft: 8,
                        borderRadius: 999,
                        borderWidth: 1,
                        borderStyle: 'solid',
                        borderColor: 'var(--t-border)',
                        background: 'var(--t-panel)',
                        color: 'var(--t-text-secondary)',
                        fontSize: 10.5,
                        fontWeight: 700,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      {group.items.length}
                    </span>
                  </div>
                  {group.items.map((agent) => {
                    const disabled = !agent.sessionKey || !onSelectSession;
                    const statusColor = STATUS_COLORS[agent.status];
                    return (
                      <button
                        key={agent.key}
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          if (!agent.sessionKey) return;
                          onSelectSession?.(agent.sessionKey);
                        }}
                        title={disabled ? agent.name : `Open ${agent.name}`}
                        style={{
                          width: 'calc(100% - 12px)',
                          minHeight: 60,
                          marginLeft: 6,
                          marginRight: 6,
                          paddingTop: 12,
                          paddingRight: 12,
                          paddingBottom: 12,
                          paddingLeft: 12,
                          borderRadius: 14,
                          borderWidth: 1,
                          borderStyle: 'solid',
                          borderColor: 'transparent',
                          background: 'transparent',
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 10,
                          textAlign: 'left',
                          cursor: disabled ? 'default' : 'pointer',
                          opacity: disabled ? 0.7 : 1,
                          transition: 'background 180ms ease, border-color 180ms ease',
                          fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                        }}
                        onMouseEnter={(event) => {
                          if (disabled) return;
                          event.currentTarget.style.background = 'var(--t-panel)';
                          event.currentTarget.style.borderColor = 'var(--t-border)';
                        }}
                        onMouseLeave={(event) => {
                          event.currentTarget.style.background = 'transparent';
                          event.currentTarget.style.borderColor = 'transparent';
                        }}
                      >
                        <span
                          style={{
                            width: 9,
                            height: 9,
                            marginTop: 5,
                            borderRadius: '50%',
                            background: statusColor,
                            flexShrink: 0,
                          }}
                        />
                        <div
                          style={{
                            flex: 1,
                            minWidth: 0,
                            display: 'flex',
                            alignItems: 'flex-start',
                            justifyContent: 'space-between',
                            gap: 10,
                          }}
                        >
                          <div
                            style={{
                              minWidth: 0,
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 4,
                              flex: 1,
                            }}
                          >
                            <span
                              style={{
                                fontSize: 12.5,
                                fontWeight: 700,
                                color: 'var(--t-text)',
                                lineHeight: 1.3,
                                letterSpacing: '-0.01em',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {agent.name}
                            </span>
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 500,
                                color: 'var(--t-text-secondary)',
                                lineHeight: 1.4,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {agent.headline}
                            </span>
                          </div>
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'flex-end',
                              gap: 6,
                              flexShrink: 0,
                              maxWidth: 92,
                            }}
                          >
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 600,
                                color: 'var(--t-text-muted)',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {formatRelativeTime(agent.lastEventAt, now)}
                            </span>
                            {agent.model ? (
                              <span
                                style={{
                                  maxWidth: 92,
                                  height: 22,
                                  paddingTop: 0,
                                  paddingRight: 8,
                                  paddingBottom: 0,
                                  paddingLeft: 8,
                                  borderRadius: 999,
                                  borderWidth: 1,
                                  borderStyle: 'solid',
                                  borderColor: 'var(--t-border)',
                                  background: 'var(--t-bg-card)',
                                  color: 'var(--t-text-secondary)',
                                  fontSize: 10,
                                  fontWeight: 700,
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {agent.model}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

export const UnifiedAgentsSidebar = memo(UnifiedAgentsSidebarBase);
