'use client';

/**
 * AgentsSidebar — global unified view of every active lane / agent from all
 * origins (CLI, MCP, Mobile, Webhook). Accessible via the TitleBar "Agents"
 * toggle button.
 *
 * Data sources:
 *   /api/lanes?active=true — SQLite-backed lane rows (runtime-agnostic)
 *   /api/command-center/snapshot — fleet agent summaries (runtime inventory)
 *
 * Rows are grouped by origin:
 *   CLI   — Codex / Claude Code / opencode sessions from the local terminal
 *   MCP   — operator-driven via the operator MCP server
 *   Mobile — activity sourced through the mobile WS surface
 *   Webhook — future: webhook-initiated agents
 *
 * Click a row → calls onFocusTab(tabId) if a bound tab is known, otherwise
 * just calls onSelectSession(sessionKey).
 *
 * Subscribes to o8:lane-lifecycle + o8:agent-lifecycle for live updates.
 * Polls every 30 s as a fallback (no-hammer).
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';

// ── Types ──

type LaneStatus = 'idle' | 'launching' | 'running' | 'paused' | 'awaiting_input' | 'reviewing' | 'merging' | 'completed' | 'archived';
type LaneRuntime = 'codex' | 'claude-code';
type LaneOwnership = 'managed' | 'attached';

interface LaneSummary {
  id: string;
  label: string;
  repoPath: string;
  branch: string;
  runtime: LaneRuntime;
  sessionKey: string | null;
  packetId: string | null;
  status: LaneStatus;
  ownership: LaneOwnership;
  lastEventAt: string | null;
  lastEventLabel: string | null;
}

type AgentStatus = 'idle' | 'running' | 'blocked' | 'waiting' | 'reviewing' | 'failed' | 'completed';

interface AgentSummary {
  id: string;
  name: string;
  runtime: string;
  status: AgentStatus;
  sessionKey: string;
  lastEventAt: string;
  currentTask?: string;
  model?: string;
  workspace?: string;
}

export type AgentOrigin = 'CLI' | 'MCP' | 'Mobile' | 'Webhook';

interface SidebarRow {
  key: string;
  origin: AgentOrigin;
  status: VisualStatus;
  name: string;
  subtitle: string;
  lastActivityAt: number;
  lastActivityLabel: string;
  sessionKey: string | null;
  tabId: string | null;
  laneId: string | null;
}

type VisualStatus = 'running' | 'waiting' | 'idle' | 'error';

interface SidebarGroup {
  origin: AgentOrigin;
  label: string;
  rows: SidebarRow[];
}

export interface AgentsSidebarProps {
  open: boolean;
  onClose: () => void;
  onFocusTab?: (tabId: string) => void;
  onSelectSession?: (sessionKey: string) => void;
}

// ── Constants ──

const STATUS_COLORS: Record<VisualStatus, string> = {
  running: '#22c55e',
  waiting: '#f59e0b',
  idle: '#9ca3af',
  error: '#ef4444',
};

const ORIGIN_LABELS: Record<AgentOrigin, string> = {
  CLI: 'CLI',
  MCP: 'MCP',
  Mobile: 'Mobile',
  Webhook: 'Webhook',
};

const SIDEBAR_TRANSITION = 'width 220ms cubic-bezier(0.22, 1, 0.36, 1), min-width 220ms cubic-bezier(0.22, 1, 0.36, 1)';
const SIDEBAR_WIDTH = 280;

// ── Icon: Sidebar close ──

function IconPanelClose({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0 }}
      aria-hidden="true"
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="m16 15-3-3 3-3" />
    </svg>
  );
}

// ── Icon: Users three (agents) ──

const USERS_THREE_PATH = 'M244.8,150.4a8,8,0,0,1-11.2-1.6A51.6,51.6,0,0,0,192,128a8,8,0,0,1-7.37-4.89,8,8,0,0,1,0-6.22A8,8,0,0,1,192,112a24,24,0,1,0-23.24-30,8,8,0,1,1-15.5-4A40,40,0,1,1,219,117.51a67.94,67.94,0,0,1,27.43,21.68A8,8,0,0,1,244.8,150.4ZM190.92,212a8,8,0,1,1-13.84,8,57,57,0,0,0-98.16,0,8,8,0,1,1-13.84-8,72.06,72.06,0,0,1,33.74-29.92,48,48,0,1,1,58.36,0A72.06,72.06,0,0,1,190.92,212ZM128,176a32,32,0,1,0-32-32A32,32,0,0,0,128,176ZM72,120a8,8,0,0,0-8-8A24,24,0,1,1,87.24,82a8,8,0,1,0,15.5-4A40,40,0,1,0,37,117.51,67.94,67.94,0,0,0,9.6,139.19a8,8,0,1,0,12.8,9.61A51.6,51.6,0,0,1,64,128,8,8,0,0,0,72,120Z';

function IconUsersThree({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d={USERS_THREE_PATH} fill="currentColor" />
    </svg>
  );
}

// ── Helpers ──

function classifyStatus(status: string | undefined): VisualStatus {
  const s = (status ?? '').toLowerCase();
  if (s.includes('running') || s.includes('active') || s.includes('working') || s === 'merging') return 'running';
  if (s.includes('wait') || s.includes('approval') || s.includes('pending') || s === 'reviewing' || s === 'awaiting_input') return 'waiting';
  if (s.includes('error') || s.includes('fail')) return 'error';
  return 'idle';
}

function classifyOrigin(runtime: string | undefined, ownership: string | undefined): AgentOrigin {
  const r = (runtime ?? '').toLowerCase();
  const o = (ownership ?? '').toLowerCase();
  if (r.includes('mobile')) return 'Mobile';
  if (r.includes('webhook')) return 'Webhook';
  if (r.includes('mcp') || o === 'mcp') return 'MCP';
  return 'CLI';
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatRelativeTime(ts: number, now: number): string {
  if (!ts) return '';
  const diff = Math.max(0, now - ts);
  if (diff < 10_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function repoShortName(repoPath: string): string {
  const parts = repoPath.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] ?? repoPath;
}

function buildRows(
  lanes: LaneSummary[],
  agents: AgentSummary[],
): SidebarRow[] {
  const rows: SidebarRow[] = [];
  const seenSessionKeys = new Set<string>();

  // Lanes first — they have richer metadata
  for (const lane of lanes) {
    const origin = classifyOrigin(lane.runtime, lane.ownership);
    const status = classifyStatus(lane.status);
    const subtitle = `${repoShortName(lane.repoPath)} / ${lane.branch}`;
    const ts = parseTimestamp(lane.lastEventAt);
    if (lane.sessionKey) seenSessionKeys.add(lane.sessionKey);

    rows.push({
      key: `lane:${lane.id}`,
      origin,
      status,
      name: lane.label || `${lane.runtime} lane`,
      subtitle,
      lastActivityAt: ts,
      lastActivityLabel: lane.lastEventLabel ?? '',
      sessionKey: lane.sessionKey,
      tabId: null,
      laneId: lane.id,
    });
  }

  // Agents not already covered by a lane sessionKey
  for (const agent of agents) {
    if (seenSessionKeys.has(agent.sessionKey)) continue;
    const origin = classifyOrigin(agent.runtime, undefined);
    const status = classifyStatus(agent.status);
    const subtitle = agent.currentTask ?? agent.workspace ?? '';
    const ts = parseTimestamp(agent.lastEventAt);

    rows.push({
      key: `agent:${agent.sessionKey}`,
      origin,
      status,
      name: agent.name || agent.runtime || 'Agent',
      subtitle,
      lastActivityAt: ts,
      lastActivityLabel: '',
      sessionKey: agent.sessionKey,
      tabId: null,
      laneId: null,
    });
  }

  return rows;
}

function groupRows(rows: SidebarRow[]): SidebarGroup[] {
  const order: AgentOrigin[] = ['CLI', 'MCP', 'Mobile', 'Webhook'];
  const buckets = new Map<AgentOrigin, SidebarRow[]>(order.map((o) => [o, []]));

  for (const row of rows) {
    buckets.get(row.origin)?.push(row);
  }

  // Sort each bucket by most recent activity descending
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  return order
    .map((origin) => ({
      origin,
      label: ORIGIN_LABELS[origin],
      rows: buckets.get(origin) ?? [],
    }))
    .filter((g) => g.rows.length > 0);
}

// ── Row Component ──

function AgentRow({
  row,
  now,
  onFocusTab,
  onSelectSession,
}: {
  row: SidebarRow;
  now: number;
  onFocusTab?: (tabId: string) => void;
  onSelectSession?: (sessionKey: string) => void;
}) {
  const statusColor = STATUS_COLORS[row.status];
  const canFocus = Boolean(row.tabId || row.sessionKey);

  const handleClick = useCallback(() => {
    if (row.tabId) {
      onFocusTab?.(row.tabId);
    } else if (row.sessionKey) {
      onSelectSession?.(row.sessionKey);
    }
  }, [row.tabId, row.sessionKey, onFocusTab, onSelectSession]);

  const timeLabel = formatRelativeTime(row.lastActivityAt, now);

  return (
    <button
      type="button"
      disabled={!canFocus}
      onClick={handleClick}
      title={canFocus ? `Focus ${row.name}` : row.name}
      style={{
        width: 'calc(100% - 12px)',
        minHeight: 56,
        marginLeft: 6,
        marginRight: 6,
        marginBottom: 2,
        paddingTop: 10,
        paddingRight: 12,
        paddingBottom: 10,
        paddingLeft: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'transparent',
        background: 'transparent',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        textAlign: 'left',
        cursor: canFocus ? 'pointer' : 'default',
        opacity: canFocus ? 1 : 0.65,
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
      }}
      onMouseEnter={(e) => {
        if (!canFocus) return;
        e.currentTarget.style.background = 'var(--t-panel)';
        e.currentTarget.style.borderColor = 'var(--t-border)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.borderColor = 'transparent';
      }}
    >
      {/* Status dot */}
      <span
        style={{
          width: 8,
          height: 8,
          marginTop: 6,
          borderRadius: '50%',
          background: statusColor,
          flexShrink: 0,
        }}
      />

      {/* Content */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
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
          {row.name}
        </span>
        {row.subtitle ? (
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
            {row.subtitle}
          </span>
        ) : null}
        {row.lastActivityLabel ? (
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 400,
              color: 'var(--t-text-muted)',
              lineHeight: 1.4,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.lastActivityLabel}
          </span>
        ) : null}
      </div>

      {/* Timestamp */}
      {timeLabel ? (
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--t-text-muted)',
            whiteSpace: 'nowrap',
            flexShrink: 0,
            marginTop: 2,
          }}
        >
          {timeLabel}
        </span>
      ) : null}
    </button>
  );
}

// ── Main Component ──

function AgentsSidebarBase({
  open,
  onClose,
  onFocusTab,
  onSelectSession,
}: AgentsSidebarProps) {
  const [lanes, setLanes] = useState<LaneSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const [lanesRes, snapshotRes] = await Promise.allSettled([
        fetch('/api/lanes?active=true', { signal: controller.signal }),
        fetch('/api/command-center/snapshot', { signal: controller.signal }),
      ]);

      if (!controller.signal.aborted) {
        if (lanesRes.status === 'fulfilled' && lanesRes.value.ok) {
          const json = await lanesRes.value.json() as { lanes?: LaneSummary[] };
          setLanes(json.lanes ?? []);
        }
        if (snapshotRes.status === 'fulfilled' && snapshotRes.value.ok) {
          const json = await snapshotRes.value.json() as { agents?: AgentSummary[] };
          setAgents(json.agents ?? []);
        }
        setNow(Date.now());
      }
    } catch {
      // AbortError is expected on cleanup — ignore all fetch errors
    }
  }, []);

  // Initial fetch + subscribe to lifecycle events
  useEffect(() => {
    void fetchData();

    const onLifecycle = () => {
      void fetchData();
      setNow(Date.now());
    };

    window.addEventListener('o8:lane-lifecycle', onLifecycle);
    window.addEventListener('o8:agent-lifecycle', onLifecycle);
    return () => {
      window.removeEventListener('o8:lane-lifecycle', onLifecycle);
      window.removeEventListener('o8:agent-lifecycle', onLifecycle);
      abortRef.current?.abort();
    };
  }, [fetchData]);

  // Fallback polling when sidebar is open (every 30 s — low cost)
  useEffect(() => {
    if (!open) return undefined;
    const interval = window.setInterval(() => {
      void fetchData();
      setNow(Date.now());
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [open, fetchData]);

  // Clock tick for relative timestamps (30 s when open)
  useEffect(() => {
    if (!open) return undefined;
    const ticker = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(ticker);
  }, [open]);

  const rows = buildRows(lanes, agents);
  const groups = groupRows(rows);
  const totalCount = rows.length;

  return (
    <div
      style={{
        width: open ? SIDEBAR_WIDTH : 0,
        minWidth: open ? SIDEBAR_WIDTH : 0,
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
          {/* Header */}
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
                <IconUsersThree size={15} />
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
                  All Agents
                </span>
                <span
                  style={{
                    fontSize: 10.5,
                    fontWeight: 500,
                    color: 'var(--t-text-secondary)',
                  }}
                >
                  {totalCount === 0
                    ? 'No agents running'
                    : `${totalCount} active ${totalCount === 1 ? 'agent' : 'agents'}`}
                </span>
              </div>
            </div>

            {/* Close button */}
            <button
              type="button"
              onClick={onClose}
              title="Close agents sidebar"
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
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--t-panel)';
                e.currentTarget.style.color = 'var(--t-text)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'var(--t-text-muted)';
              }}
            >
              <IconPanelClose size={13} />
            </button>
          </div>

          {/* Body */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              paddingTop: 8,
              paddingBottom: 12,
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
                  paddingTop: 32,
                  paddingRight: 18,
                  paddingBottom: 32,
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
                  <IconUsersThree size={18} />
                </div>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--t-text)',
                    letterSpacing: '-0.01em',
                  }}
                >
                  No agents running.
                </span>
                <span
                  style={{
                    fontSize: 11,
                    lineHeight: 1.5,
                    color: 'var(--t-text-secondary)',
                    textAlign: 'center',
                    maxWidth: 220,
                  }}
                >
                  Active lanes from CLI, MCP, and Mobile runtimes will appear here.
                </span>
              </div>
            ) : (
              groups.map((group) => (
                <div key={group.origin}>
                  {/* Group header */}
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
                        minWidth: 20,
                        height: 20,
                        paddingTop: 0,
                        paddingRight: 7,
                        paddingBottom: 0,
                        paddingLeft: 7,
                        borderRadius: 999,
                        borderWidth: 1,
                        borderStyle: 'solid',
                        borderColor: 'var(--t-border)',
                        background: 'var(--t-panel)',
                        color: 'var(--t-text-secondary)',
                        fontSize: 10,
                        fontWeight: 700,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      {group.rows.length}
                    </span>
                  </div>

                  {/* Rows */}
                  {group.rows.map((row) => (
                    <AgentRow
                      key={row.key}
                      row={row}
                      now={now}
                      onFocusTab={onFocusTab}
                      onSelectSession={onSelectSession}
                    />
                  ))}
                </div>
              ))
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

export const AgentsSidebar = memo(AgentsSidebarBase);
