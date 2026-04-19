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

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

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

const FONT = '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif';

// ── Helpers ──

function classifyStatus(status: string | undefined): VisualStatus {
  const s = (status ?? '').toLowerCase();
  if (s === 'archived') return 'archived';
  if (s.includes('running') || s.includes('active') || s.includes('working') || s === 'merging') return 'running';
  if (s.includes('wait') || s.includes('approval') || s.includes('pending') || s === 'reviewing' || s === 'awaiting_input') return 'waiting';
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
    if (origin === 'CLI') {
      // CLI rows already render inside repo cards via the per-branch feed.
      if (lane.sessionKey) seenSessionKeys.add(lane.sessionKey);
      continue;
    }
    const status = classifyStatus(lane.status);
    if (lane.sessionKey) seenSessionKeys.add(lane.sessionKey);
    rows.push({
      key: `lane:${lane.id}`,
      origin,
      status,
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

function ExtraAgentRowView({
  row,
  onSelectSession,
}: {
  row: ExtraAgentRow;
  onSelectSession?: (sessionKey: string) => void;
}) {
  const statusColor = STATUS_COLORS[row.status];
  const canFocus = Boolean(row.sessionKey && onSelectSession);
  const handleClick = useCallback(() => {
    if (row.sessionKey) onSelectSession?.(row.sessionKey);
  }, [row.sessionKey, onSelectSession]);

  return (
    <button
      type="button"
      disabled={!canFocus}
      onClick={handleClick}
      title={canFocus ? `Focus ${row.name}` : row.name}
      style={{
        width: '100%',
        minHeight: 28,
        paddingTop: 5,
        paddingBottom: 5,
        paddingLeft: 14,
        paddingRight: 14,
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
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: statusColor,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12,
          fontWeight: 440,
          color: 'var(--t-text)',
          letterSpacing: '-0.005em',
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
              fontSize: 11,
              color: 'var(--t-text-muted)',
              fontWeight: 400,
            }}
          >
            {row.subtitle}
          </span>
        ) : null}
      </span>
      <OriginChip origin={row.origin} />
    </button>
  );
}

function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        paddingTop: 8,
        paddingRight: 14,
        paddingBottom: 3,
        paddingLeft: 14,
        fontFamily: FONT,
      }}
    >
      <span
        style={{
          fontSize: 9,
          fontWeight: 600,
          color: 'var(--t-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 9,
          fontWeight: 600,
          color: 'var(--t-text-faint)',
          fontFamily: '"SF Mono", ui-monospace, monospace',
        }}
      >
        {count}
      </span>
    </div>
  );
}

// ── Main component ──

function AgentPanelExtraAgentsBase({ onSelectSession }: AgentPanelExtraAgentsProps) {
  const [lanes, setLanes] = useState<LaneSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [repos, setRepos] = useState<RegisteredRepo[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const [lanesRes, snapshotRes, reposRes] = await Promise.allSettled([
        fetch('/api/lanes?active=true', { signal: controller.signal }),
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
  const groups = useMemo(() => groupRows(rows, repos), [rows, repos]);

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
      {groups.map((group) => (
        <div key={group.key}>
          <GroupHeader label={group.label} count={group.rows.length} />
          {group.rows.map((row) => (
            <ExtraAgentRowView
              key={row.key}
              row={row}
              onSelectSession={onSelectSession}
            />
          ))}
        </div>
      ))}
    </section>
  );
}

export const AgentPanelExtraAgents = memo(AgentPanelExtraAgentsBase);
