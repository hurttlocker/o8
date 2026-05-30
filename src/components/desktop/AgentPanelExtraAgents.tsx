'use client';

/**
 * AgentPanelExtraAgents — the #515 / #627 fold-in. Shows every active lane /
 * agent from non-CLI origins (MCP, Mobile, Webhook, Cloud) that wouldn't
 * otherwise surface in the per-branch row stack from RepoRegistrySection.
 *
 * Rendered BELOW the RepoRegistrySection inside AgentPanel. Uses the existing
 * Rams-dense row treatment — no new chrome, no extra panel, no launcher. If
 * there are no non-CLI lanes, this component renders nothing.
 *
 * Layout:
 *   [repoA/ugc]           ← group header (repo name)
 *     Agent row + origin chip (MCP / MOBILE / WEBHOOK / CLOUD)
 *     Agent row + origin chip
 *   [repoB/spear]
 *     Agent row + origin chip
 *   [OTHER]              ← cross-repo agents (no bound repoPath)
 *     Agent row + origin chip
 *
 * Data sources (merged and deduped by sessionKey):
 *   /api/lanes?active=true — SQLite-backed lane rows (runtime-agnostic)
 *   /api/command-center/snapshot — fleet agent summaries
 *   /api/panel/repos — registered repo list (to map repoPath → short name)
 *
 * Subscribes to `o8:lane-lifecycle` + `o8:agent-lifecycle` for instant
 * refresh. Polls every 5 min as a fallback, consistent with AgentPanel.
 *
 * CLI origin rows intentionally omitted — those already render inside the
 * repo cards via useAgentPanelState's runtime inventory feed.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Folder as IconoirFolder } from 'iconoir-react';
import { ClaudeIcon, CodexIcon } from '@/components/desktop/repo-registry/shared';
import { ChevronDown, ChevronRight } from '@/components/desktop/lucide-shims';
import { AgentStatusDot, type AgentDotState } from '@/components/desktop/AgentStatusDot';

// ── Types ──

type LaneStatus = 'idle' | 'launching' | 'running' | 'paused' | 'awaiting_input' | 'awaiting_orchestrator' | 'reviewing' | 'merging' | 'failed' | 'completed' | 'archived';
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

interface RegisteredRepo {
  id: string;
  name: string;
  localPath: string;
}

type AgentOrigin = 'CLI' | 'MCP' | 'Mobile' | 'Webhook' | 'Cloud';
type VisualStatus = 'running' | 'waiting' | 'idle' | 'error' | 'archived';

interface ExtraAgentRow {
  key: string;
  origin: AgentOrigin;
  status: VisualStatus;
  runtime: string;
  name: string;
  subtitle: string;
  lastActivityAt: number;
  sessionKey: string | null;
  repoPath: string | null;
}

interface ExtraAgentGroup {
  key: string;
  label: string;
  rows: ExtraAgentRow[];
}

export interface AgentPanelExtraAgentsProps {
  onSelectSession?: (sessionKey: string) => void;
}

// ── Constants ──

const STATUS_COLORS: Record<VisualStatus, string> = {
  running: '#22c55e',
  waiting: '#f59e0b',
  idle: '#9ca3af',
  error: '#ef4444',
  archived: '#6b7280',
};

const ORIGIN_LABELS: Record<AgentOrigin, string> = {
  CLI: 'CLI',
  MCP: 'MCP',
  Mobile: 'Mobile',
  Webhook: 'Webhook',
  Cloud: 'Cloud',
};

const FONT = 'var(--font-sans-system)';

// ── Helpers ──

function classifyStatus(status: string | undefined): VisualStatus {
  const s = (status ?? '').toLowerCase();
  if (s === 'archived') return 'archived';
  if (s.includes('running') || s.includes('active') || s.includes('working') || s === 'merging') return 'running';
  if (s.includes('wait') || s.includes('approval') || s.includes('pending') || s === 'reviewing' || s === 'awaiting_input' || s === 'awaiting_orchestrator') return 'waiting';
  if (s.includes('error') || s.includes('fail')) return 'error';
  return 'idle';
}

function classifyOrigin(runtime: string | undefined, ownership: string | undefined): AgentOrigin {
  const r = (runtime ?? '').toLowerCase();
  const o = (ownership ?? '').toLowerCase();
  if (r.includes('cloud')) return 'Cloud';
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

function normalizePath(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : null;
}

function mapRepoPathToRegistered(
  repoPath: string | null,
  repos: RegisteredRepo[],
): RegisteredRepo | null {
  if (!repoPath) return null;
  const normalized = normalizePath(repoPath);
  if (!normalized) return null;
  for (const repo of repos) {
    const repoNormalized = normalizePath(repo.localPath);
    if (!repoNormalized) continue;
    if (normalized === repoNormalized || normalized.startsWith(`${repoNormalized}/`)) {
      return repo;
    }
  }
  return null;
}

function buildRows(
  lanes: LaneSummary[],
  agents: AgentSummary[],
): ExtraAgentRow[] {
  const rows: ExtraAgentRow[] = [];
  const seenSessionKeys = new Set<string>();

  for (const lane of lanes) {
    const origin = classifyOrigin(lane.runtime, lane.ownership);
    // CLI lanes (MCP-dispatched codex packets, etc.) were previously
    // skipped on the assumption that the per-branch repo-card feed
    // already surfaced them — but that path doesn't pick up packets
    // sitting in reviewing / awaiting_input, leaving the operator with
    // no way to see what got spawned. Surface them here too.
    const status = classifyStatus(lane.status);
    if (lane.sessionKey) seenSessionKeys.add(lane.sessionKey);
    rows.push({
      key: `lane:${lane.id}`,
      origin,
      status,
      runtime: lane.runtime,
      name: lane.label || `${lane.runtime} lane`,
      subtitle: lane.branch,
      lastActivityAt: parseTimestamp(lane.lastEventAt),
      sessionKey: lane.sessionKey,
      repoPath: normalizePath(lane.repoPath),
    });
  }

  for (const agent of agents) {
    if (seenSessionKeys.has(agent.sessionKey)) continue;
    const origin = classifyOrigin(agent.runtime, undefined);
    if (origin === 'CLI') continue;
    const status = classifyStatus(agent.status);
    rows.push({
      key: `agent:${agent.sessionKey}`,
      origin,
      status,
      runtime: agent.runtime ?? '',
      name: agent.name || agent.runtime || 'Agent',
      subtitle: agent.currentTask ?? '',
      lastActivityAt: parseTimestamp(agent.lastEventAt),
      sessionKey: agent.sessionKey,
      repoPath: normalizePath(agent.workspace),
    });
  }

  return rows;
}

function groupRows(
  rows: ExtraAgentRow[],
  repos: RegisteredRepo[],
): ExtraAgentGroup[] {
  const byRepo = new Map<string, ExtraAgentRow[]>();
  const other: ExtraAgentRow[] = [];
  const repoNameById = new Map<string, string>();

  for (const row of rows) {
    const matched = mapRepoPathToRegistered(row.repoPath, repos);
    if (matched) {
      repoNameById.set(matched.id, matched.name);
      const bucket = byRepo.get(matched.id) ?? [];
      bucket.push(row);
      byRepo.set(matched.id, bucket);
    } else {
      other.push(row);
    }
  }

  const groups: ExtraAgentGroup[] = [];
  const sortedRepoIds = [...byRepo.keys()].sort((a, b) => {
    const nameA = repoNameById.get(a) ?? a;
    const nameB = repoNameById.get(b) ?? b;
    return nameA.localeCompare(nameB);
  });
  for (const repoId of sortedRepoIds) {
    const bucket = byRepo.get(repoId) ?? [];
    bucket.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    groups.push({
      key: `repo:${repoId}`,
      label: repoNameById.get(repoId) ?? repoId,
      rows: bucket,
    });
  }
  if (other.length > 0) {
    other.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    groups.push({
      key: 'other',
      label: 'Other',
      rows: other,
    });
  }
  return groups;
}

// ── Small children ──

function OriginChip({ origin }: { origin: AgentOrigin }) {
  // CLI is the implicit default — unchipped. Only non-CLI origins get a chip.
  if (origin === 'CLI') return null;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: 5,
        paddingRight: 5,
        borderRadius: 4,
        border: '1px solid var(--t-border-subtle)',
        fontSize: 9,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: 'var(--t-text-muted)',
        fontFamily: FONT,
      }}
    >
      {ORIGIN_LABELS[origin]}
    </span>
  );
}

function RuntimeGlyph({ runtime }: { runtime: string }) {
  const r = runtime.toLowerCase();
  if (r.includes('claude')) return <ClaudeIcon size={13} />;
  if (r.includes('codex') || r.startsWith('gpt')) return <CodexIcon size={13} />;
  return (
    <span
      aria-hidden="true"
      style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: 'var(--t-text-muted)',
        opacity: 0.6,
        display: 'inline-block',
      }}
    />
  );
}

function ExtraAgentRowView({
  row,
  onSelectSession,
  onOpenMenu,
}: {
  row: ExtraAgentRow;
  onSelectSession?: (sessionKey: string) => void;
  onOpenMenu?: (event: ReactMouseEvent, row: ExtraAgentRow) => void;
}) {
  // Same status vocabulary as the chat rows (AgentStatusDot): accent pulse
  // while running — flips to the binary orbit once long-running — review
  // orange, failed red, idle ring. Keeps the panel unified with the history list.
  const dotState: AgentDotState =
    row.status === 'running' ? 'running'
      : row.status === 'waiting' ? 'review'
        : row.status === 'error' ? 'failed'
          : 'idle';
  const canFocus = Boolean(row.sessionKey && onSelectSession);
  const handleClick = useCallback(() => {
    if (row.sessionKey) onSelectSession?.(row.sessionKey);
  }, [row.sessionKey, onSelectSession]);

  return (
    <button
      type="button"
      disabled={!canFocus}
      onClick={handleClick}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu?.(event, row);
      }}
      title={canFocus ? `Focus ${row.name}` : row.name}
      style={{
        width: '100%',
        minHeight: 28,
        paddingTop: 5,
        paddingBottom: 5,
        // Aligned with HistoryChatRow chat-text X (37) so spawned agents
        // share the same left rail as project chats above. paddingRight
        // matches HistoryChatRow (12) so trailing motion rings sit on
        // the same vertical column.
        paddingLeft: 37,
        paddingRight: 12,
        borderWidth: 0,
        background: 'transparent',
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        textAlign: 'left',
        cursor: canFocus ? 'pointer' : 'default',
        opacity: row.status === 'archived' ? 0.58 : 1,
        fontFamily: FONT,
      }}
      onMouseEnter={(e) => {
        if (!canFocus) return;
        e.currentTarget.style.background = 'var(--t-panel-hover, rgba(148,163,184,0.08))';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13.5,
          fontWeight: 300,
          color: 'var(--t-text)',
          letterSpacing: '-0.1px',
          lineHeight: 1.25,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {row.name}
        {row.subtitle ? (
          <span
            style={{
              marginLeft: 6,
              fontSize: 9.5,
              color: 'var(--t-text-muted)',
              fontWeight: 260,
              letterSpacing: '-0.4px',
            }}
          >
            {row.subtitle}
          </span>
        ) : null}
      </span>
      <OriginChip origin={row.origin} />
      <AgentStatusDot state={dotState} />
    </button>
  );
}

function GroupHeader({
  label,
  count,
  collapsible = false,
  collapsed = false,
  onToggle,
}: {
  label: string;
  count?: number;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const body = (
    <>
      {collapsible ? (
        collapsed ? (
          <ChevronRight size={11} strokeWidth={2} style={{ color: 'var(--t-text-faint)' }} />
        ) : (
          <ChevronDown size={11} strokeWidth={2} style={{ color: 'var(--t-text-faint)' }} />
        )
      ) : (
        // Folder glyph for repo sub-headers (cortex-ide, o8-site under
        // Spawned agents). Matches the main repo header's folder icon
        // so all repo names carry the same prefix vocabulary.
        <span
          aria-hidden
          style={{
            width: 11,
            height: 11,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--t-text-faint)',
            flexShrink: 0,
          }}
        >
          <IconoirFolder width={11} height={11} color="currentColor" strokeWidth={1.6} />
        </span>
      )}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 10,
          fontWeight: 300,
          color: 'var(--t-text-faint)',
          letterSpacing: '-0.1px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      {typeof count === 'number' ? (
        <span
          style={{
            fontSize: 10,
            fontWeight: 300,
            color: 'var(--t-text-faint)',
            fontFamily: '"SF Mono", ui-monospace, monospace',
            flexShrink: 0,
          }}
        >
          {count}
        </span>
      ) : null}
    </>
  );

  const commonStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    paddingTop: 8,
    paddingRight: 12,
    paddingBottom: 3,
    paddingLeft: 12,
    fontFamily: FONT,
  };

  if (collapsible && onToggle) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={collapsed ? `Show ${label.toLowerCase()}` : `Hide ${label.toLowerCase()}`}
        style={{
          ...commonStyle,
          width: '100%',
          borderWidth: 0,
          background: 'transparent',
          cursor: 'pointer',
          outline: 'none',
          textAlign: 'left',
        }}
      >
        {body}
      </button>
    );
  }

  return <div style={commonStyle}>{body}</div>;
}

// ── Main component ──

const COLLAPSED_KEY = 'o8:agent-panel:spawned-agents-collapsed';

interface ActionMenuState {
  x: number;
  y: number;
  row: ExtraAgentRow;
}

function AgentPanelExtraAgentsBase({ onSelectSession }: AgentPanelExtraAgentsProps) {
  const [lanes, setLanes] = useState<LaneSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [repos, setRepos] = useState<RegisteredRepo[]>([]);
  const [actionMenu, setActionMenu] = useState<ActionMenuState | null>(null);
  const [archivedSessionKeys, setArchivedSessionKeys] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  });
  const abortRef = useRef<AbortController | null>(null);

  const handleArchive = useCallback(async (row: ExtraAgentRow) => {
    if (!row.sessionKey) return;
    const sessionKey = row.sessionKey;
    setArchivedSessionKeys((prev) => {
      if (prev.has(sessionKey)) return prev;
      const next = new Set(prev);
      next.add(sessionKey);
      return next;
    });
    setBusy(true);
    try {
      await fetch('/api/runtime/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey }),
      });
    } catch {
      // Roll back the optimistic hide so operator can retry.
      setArchivedSessionKeys((prev) => {
        if (!prev.has(sessionKey)) return prev;
        const next = new Set(prev);
        next.delete(sessionKey);
        return next;
      });
    } finally {
      setBusy(false);
    }
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
      }
      return next;
    });
  }, []);

  const fetchData = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const [lanesRes, snapshotRes, reposRes] = await Promise.allSettled([
        // No `active=true` filter — operator wants every spawned agent
        // visible regardless of state (reviewing / awaiting_input / idle /
        // failed). Was hiding the entire backlog of MCP-dispatched packets.
        fetch('/api/lanes', { signal: controller.signal }),
        fetch('/api/command-center/snapshot', { signal: controller.signal }),
        fetch('/api/panel/repos', { signal: controller.signal }),
      ]);

      if (controller.signal.aborted) return;

      if (lanesRes.status === 'fulfilled' && lanesRes.value.ok) {
        const json = await lanesRes.value.json() as { lanes?: LaneSummary[] };
        setLanes(json.lanes ?? []);
      }
      if (snapshotRes.status === 'fulfilled' && snapshotRes.value.ok) {
        const json = await snapshotRes.value.json() as { agents?: AgentSummary[] };
        setAgents(json.agents ?? []);
      }
      if (reposRes.status === 'fulfilled' && reposRes.value.ok) {
        const json = await reposRes.value.json() as { repos?: RegisteredRepo[] };
        setRepos((json.repos ?? []).map((r) => ({ id: r.id, name: r.name, localPath: r.localPath })));
      }
    } catch {
      // AbortError on teardown — silently ignore.
    }
  }, []);

  useEffect(() => {
    void fetchData();
    const onLifecycle = () => { void fetchData(); };
    window.addEventListener('o8:lane-lifecycle', onLifecycle);
    window.addEventListener('o8:agent-lifecycle', onLifecycle);
    const fallbackId = window.setInterval(fetchData, 300_000);
    return () => {
      window.removeEventListener('o8:lane-lifecycle', onLifecycle);
      window.removeEventListener('o8:agent-lifecycle', onLifecycle);
      window.clearInterval(fallbackId);
      abortRef.current?.abort();
    };
  }, [fetchData]);

  const rows = useMemo(() => buildRows(lanes, agents), [lanes, agents]);
  const visibleRows = useMemo(
    () => rows.filter((row) => !(row.sessionKey && archivedSessionKeys.has(row.sessionKey))),
    [rows, archivedSessionKeys],
  );
  const groups = useMemo(() => groupRows(visibleRows, repos), [visibleRows, repos]);

  if (groups.length === 0) return null;

  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        paddingTop: 4,
        paddingBottom: 8,
        borderTop: '1px solid var(--t-divider-subtle)',
        marginTop: 4,
      }}
    >
      <GroupHeader
        label="Spawned agents"
        collapsible
        collapsed={collapsed}
        onToggle={toggleCollapsed}
      />
      {!collapsed ? groups.map((group) => (
        <div key={group.key}>
          <GroupHeader label={group.label} />
          {group.rows.map((row) => (
            <ExtraAgentRowView
              key={row.key}
              row={row}
              onSelectSession={onSelectSession}
              onOpenMenu={(event, targetRow) => {
                setActionMenu({ x: event.clientX, y: event.clientY, row: targetRow });
              }}
            />
          ))}
        </div>
      )) : null}
      {actionMenu ? (
        <ExtraAgentActionMenu
          state={actionMenu}
          busy={busy}
          canFocus={Boolean(actionMenu.row.sessionKey && onSelectSession)}
          onClose={() => setActionMenu(null)}
          onFocus={() => {
            if (actionMenu.row.sessionKey) onSelectSession?.(actionMenu.row.sessionKey);
            setActionMenu(null);
          }}
          onArchive={() => {
            void handleArchive(actionMenu.row);
            setActionMenu(null);
          }}
        />
      ) : null}
    </section>
  );
}

function ExtraAgentActionMenu({
  state,
  busy,
  canFocus,
  onClose,
  onFocus,
  onArchive,
}: {
  state: ActionMenuState;
  busy: boolean;
  canFocus: boolean;
  onClose: () => void;
  onFocus: () => void;
  onArchive: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const menuWidth = 190;
  const menuHeight = 130;
  const panelRect = typeof document === 'undefined'
    ? null
    : document.querySelector('[data-o8-agent-panel="true"]')?.getBoundingClientRect() ?? null;
  const viewportWidth = typeof window === 'undefined' ? 1200 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
  const boundaryLeft = panelRect?.left ?? 0;
  const boundaryRight = panelRect?.right ?? viewportWidth;
  const boundaryTop = panelRect?.top ?? 0;
  const boundaryBottom = panelRect?.bottom ?? viewportHeight;
  const minLeft = boundaryLeft + 8;
  const maxLeft = Math.max(minLeft, boundaryRight - menuWidth - 8);
  const left = Math.min(Math.max(state.x, minLeft), maxLeft);
  const minTop = boundaryTop + 8;
  const maxTop = Math.max(minTop, boundaryBottom - menuHeight - 8);
  const top = Math.min(Math.max(state.y, minTop), maxTop);

  return (
    <>
      <button
        type="button"
        aria-label="Close spawned agent action menu"
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 58, border: 0, background: 'transparent', cursor: 'default' }}
      />
      <div
        style={{
          position: 'fixed',
          left,
          top,
          zIndex: 59,
          width: menuWidth,
          borderRadius: 13,
          border: '1px solid var(--t-divider-subtle)',
          background: 'color-mix(in srgb, var(--t-bg-elevated, #ffffff) 86%, transparent)',
          boxShadow: '0 18px 48px rgba(15, 23, 42, 0.12)',
          backdropFilter: 'blur(18px) saturate(145%)',
          WebkitBackdropFilter: 'blur(18px) saturate(145%)',
          padding: 7,
          color: 'var(--t-text)',
        }}
      >
        <div style={{ padding: '4px 7px 7px' }}>
          <div style={{ fontSize: 11.25, lineHeight: '15px', fontWeight: 620, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {state.row.name}
          </div>
          <div style={{ marginTop: 1, color: 'var(--t-text-faint)', fontSize: 10, lineHeight: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {state.row.subtitle || state.row.runtime}
          </div>
        </div>
        <div style={{ display: 'grid', gap: 2 }}>
          <ExtraAgentMenuRow label="Open" disabled={!canFocus || busy} onClick={onFocus} />
          <ExtraAgentMenuRow label="Archive" disabled={busy || !state.row.sessionKey} onClick={onArchive} />
        </div>
      </div>
    </>
  );
}

function ExtraAgentMenuRow({
  label,
  disabled = false,
  danger = false,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      style={{
        width: '100%',
        minHeight: 29,
        borderRadius: 9,
        border: 0,
        background: 'transparent',
        color: disabled ? 'var(--t-text-faint)' : danger ? '#dc2626' : 'var(--t-text-muted)',
        cursor: disabled ? 'default' : 'pointer',
        textAlign: 'left',
        paddingTop: 0,
        paddingRight: 9,
        paddingBottom: 0,
        paddingLeft: 9,
        fontSize: 11.25,
        lineHeight: '15px',
        fontWeight: danger ? 620 : 560,
        transition: 'background 120ms ease, color 120ms ease',
      }}
      onMouseEnter={(event) => {
        if (disabled) return;
        event.currentTarget.style.background = 'var(--t-hover)';
        event.currentTarget.style.color = danger ? '#dc2626' : 'var(--t-text)';
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent';
        event.currentTarget.style.color = disabled ? 'var(--t-text-faint)' : danger ? '#dc2626' : 'var(--t-text-muted)';
      }}
    >
      {label}
    </button>
  );
}

export const AgentPanelExtraAgents = memo(AgentPanelExtraAgentsBase);
