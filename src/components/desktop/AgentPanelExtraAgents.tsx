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
 *   [unregistered]       ← cross-repo agents (no registered repoPath)
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
import { Folder as IconoirFolder } from 'iconoir-react';
import { ChevronDown, ChevronRight } from '@/components/desktop/lucide-shims';
import { deriveParkedLaneBuckets, type ReviewApprovalSummary } from '@/components/desktop/merge-beacon/derive';
import {
  ExtraAgentActionMenu,
  ExtraAgentRowView,
  type AgentOrigin,
  type ExtraAgentActionMenuState,
  type ExtraAgentRow,
  type LaneStatus,
  type VisualStatus,
} from './AgentPanelExtraAgentRow';
import { SpawnedAgentHoverCard } from './SpawnedAgentHoverCard';
import { callRetryPacket } from '@/lib/orchestrator/packet-actions';

// ── Types ──

type LaneRuntime = 'codex' | 'claude-code' | 'gemini' | 'antigravity' | 'opencode' | 'cursor' | 'grok';
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
  outcome?: 'no_changes' | 'merged' | 'discarded' | null;
  outcomeNote?: string | null;
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
  exists?: boolean;
}

interface ExtraAgentGroup {
  key: string;
  label: string;
  rows: ExtraAgentRow[];
  tooltip: string;
  unregistered: boolean;
}

export interface AgentPanelExtraAgentsProps {
  activeSessionKey?: string | null;
  onSelectSession?: (sessionKey: string) => void;
  /** Packet ids already rendered as nested owned-worker rows under their
   *  orchestrator thread in the rail — excluded here to avoid double-listing. */
  hidePacketIds?: ReadonlySet<string>;
}

// ── Constants ──

const FONT = 'var(--font-sans-system)';
const FOCUS_LANE_EVENT = 'o8:focus-spawned-agent-lane';
const RECENT_TERMINAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_TERMINAL_CAP_PER_REPO = 8;

// ── Helpers ──

function classifyStatus(status: string | undefined): VisualStatus {
  const s = (status ?? '').toLowerCase();
  if (s === 'archived') return 'archived';
  if (s.includes('running') || s.includes('active') || s.includes('working') || s === 'merging') return 'running';
  if (s.includes('wait') || s.includes('approval') || s.includes('pending') || s === 'reviewing' || s === 'awaiting_input' || s === 'awaiting_human' || s === 'awaiting_orchestrator') return 'waiting';
  if (s.includes('error') || s.includes('fail') || s === 'recovering') return 'error';
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

function pathBasename(value: string | null | undefined): string {
  const parts = normalizePath(value)?.split('/').filter(Boolean) ?? [];
  return parts.at(-1) ?? 'Unbound';
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
  rejectedPacketIds: ReadonlySet<string>,
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
      packetId: lane.packetId,
      laneId: lane.id,
      laneStatus: lane.status,
      outcome: lane.outcome ?? null,
      outcomeNote: lane.outcomeNote ?? null,
      lastEventLabel: lane.lastEventLabel,
      rejected: lane.packetId ? rejectedPacketIds.has(lane.packetId) : false,
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
      packetId: null,
      laneId: null,
      laneStatus: null,
      outcome: null,
      outcomeNote: null,
      lastEventLabel: null,
    });
  }

  return rows;
}

function groupRows(
  rows: ExtraAgentRow[],
  repos: RegisteredRepo[],
): ExtraAgentGroup[] {
  const byRepo = new Map<string, ExtraAgentGroup>();

  for (const row of rows) {
    const matched = mapRepoPathToRegistered(row.repoPath, repos);
    const normalizedPath = normalizePath(row.repoPath);
    // Registered repos consolidate under ONE group keyed by repo id — a
    // dispatched packet's worktree path (.cortex-worktrees/packet-*) resolves
    // to its parent repo, never its own group. Basename + unregistered
    // treatment is only for paths that resolve to no registered repo.
    const key = matched ? `id:${matched.id}` : normalizedPath ?? '__unbound__';
    const unregistered = !matched || matched.exists === false;
    const tooltip = matched
      ? matched.exists === false
        ? `${normalizePath(matched.localPath) ?? matched.localPath} · missing on disk`
        : normalizePath(matched.localPath) ?? matched.localPath
      : normalizedPath == null
        ? 'No repo path reported'
        : normalizedPath;
    const existing = byRepo.get(key);
    if (existing) {
      existing.rows.push(row);
      continue;
    }

    byRepo.set(key, {
      key: `repo:${key}`,
      label: matched ? matched.name : pathBasename(normalizedPath),
      tooltip,
      rows: [row],
      unregistered,
    });
  }

  const groups = [...byRepo.values()].sort((a, b) => a.label.localeCompare(b.label));
  for (const group of groups) {
    group.rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    // Live work leads; the day's finished agents follow as the Recent tail
    // (recency-sorted, capped) so the rail reads "what's happening, then
    // what happened" without flooding on a heavy mission day.
    const live = group.rows.filter((row) => !(row.laneStatus === 'archived' || row.laneStatus === 'completed'));
    const terminal = group.rows
      .filter((row) => row.laneStatus === 'archived' || row.laneStatus === 'completed')
      .slice(0, RECENT_TERMINAL_CAP_PER_REPO);
    group.rows = [...live, ...terminal];
  }
  return groups;
}

function GroupHeader({
  label,
  count,
  collapsible = false,
  collapsed = false,
  onToggle,
  tooltip,
  unregistered = false,
}: {
  label: string;
  count?: number;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  tooltip?: string;
  unregistered?: boolean;
}) {
  const headerInk = unregistered ? 'var(--t-text-muted)' : 'var(--t-text-faint)';
  const body = (
    <>
      {collapsible ? (
        collapsed ? (
          <ChevronRight size={11} strokeWidth={2} style={{ color: 'var(--t-text-faint)' }} />
        ) : (
          <ChevronDown size={11} strokeWidth={2} style={{ color: 'var(--t-text-faint)' }} />
        )
      ) : (
        // Folder glyph for repo sub-headers (o8, o8-site under
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
            color: headerInk,
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
          color: headerInk,
          letterSpacing: '-0.1px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      {unregistered ? (
        <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--t-text-faint)', letterSpacing: '-0.2px', flexShrink: 0 }}>
          unregistered
        </span>
      ) : null}
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
        title={tooltip ?? (collapsed ? `Show ${label.toLowerCase()}` : `Hide ${label.toLowerCase()}`)}
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

  return <div title={tooltip} style={commonStyle}>{body}</div>;
}

// ── Main component ──

const COLLAPSED_KEY = 'o8:agent-panel:spawned-agents-collapsed';

function AgentPanelExtraAgentsBase({ activeSessionKey, onSelectSession, hidePacketIds }: AgentPanelExtraAgentsProps) {
  const [lanes, setLanes] = useState<LaneSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [repos, setRepos] = useState<RegisteredRepo[]>([]);
  const [rejectedPacketIds, setRejectedPacketIds] = useState<Set<string>>(() => new Set());
  const [actionMenu, setActionMenu] = useState<ExtraAgentActionMenuState | null>(null);
  const [archivedSessionKeys, setArchivedSessionKeys] = useState<Set<string>>(() => new Set());
  const [hoverCard, setHoverCard] = useState<{ row: ExtraAgentRow; rect: DOMRect } | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  });
  const abortRef = useRef<AbortController | null>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);

  const cancelHoverClose = useCallback(() => {
    if (hoverCloseTimerRef.current == null) return;
    window.clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = null;
  }, []);

  const scheduleHoverClose = useCallback(() => {
    cancelHoverClose();
    hoverCloseTimerRef.current = window.setTimeout(() => {
      setHoverCard(null);
      hoverCloseTimerRef.current = null;
    }, 120);
  }, [cancelHoverClose]);

  const openHoverCard = useCallback((row: ExtraAgentRow, rect: DOMRect) => {
    cancelHoverClose();
    setHoverCard({ row, rect });
  }, [cancelHoverClose]);

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
      const [lanesRes, snapshotRes, reposRes, approvalsRes] = await Promise.allSettled([
        // Pull terminal rows too, then retain only the explicit no-change
        // terminal outcome alongside live rows. A completed no-op must remain
        // visible without flooding the rail with the full archive backlog.
        fetch('/api/lanes?active=false', { signal: controller.signal }),
        fetch('/api/command-center/snapshot', { signal: controller.signal }),
        fetch('/api/panel/repos', { signal: controller.signal }),
        // Approvals feed the 'rejected' dot — the durable review verdict the
        // lane status alone can't tell us (a rejected lane still reads
        // 'reviewing'). Same source the merge beacon + banner use.
        fetch('/api/panel/approvals?status=all', { signal: controller.signal }),
      ]);

      if (controller.signal.aborted) return;

      let laneList: LaneSummary[] = [];
      if (lanesRes.status === 'fulfilled' && lanesRes.value.ok) {
        const json = await lanesRes.value.json() as { lanes?: LaneSummary[] };
        laneList = (json.lanes ?? []).filter((lane) => {
          const terminal = lane.status === 'archived' || lane.status === 'completed';
          if (!terminal) return true;
          // Recent group (Q ruling 2026-07-18: terminal agents live in the
          // CLEAN view, not behind a click): outcome-stamped terminal lanes
          // from the last 24h stay on the rail with their truthful chip.
          // Legacy archives with no outcome (reset/rerun cleanup noise) stay
          // hidden — resurrecting history isn't the point, the day's work is.
          if (!lane.outcome) return false;
          const at = Date.parse(lane.lastEventAt ?? '');
          return Number.isFinite(at) && Date.now() - at < RECENT_TERMINAL_WINDOW_MS;
        });
        setLanes(laneList);
      }

      if (approvalsRes.status === 'fulfilled' && approvalsRes.value.ok) {
        const json = await approvalsRes.value.json() as { approvals?: ReviewApprovalSummary[] };
        const domainLanes = laneList
          .filter((lane) => lane.packetId)
          .map((lane) => ({
            laneId: lane.id,
            packetId: lane.packetId as string,
            status: lane.status,
            outcome: lane.outcome ?? null,
            sessionKey: lane.sessionKey,
            lastEventLabel: lane.lastEventLabel,
          }));
        const rejected = deriveParkedLaneBuckets(domainLanes, json.approvals ?? []).rejected;
        setRejectedPacketIds(new Set(rejected.map((entry) => entry.packetId)));
      }
      if (snapshotRes.status === 'fulfilled' && snapshotRes.value.ok) {
        const json = await snapshotRes.value.json() as { agents?: AgentSummary[] };
        setAgents(json.agents ?? []);
      }
      if (reposRes.status === 'fulfilled' && reposRes.value.ok) {
        const json = await reposRes.value.json() as { repos?: RegisteredRepo[] };
        setRepos((json.repos ?? []).map((r) => ({ id: r.id, name: r.name, localPath: r.localPath, exists: r.exists })));
      }
    } catch {
      // AbortError on teardown — silently ignore.
    }
  }, []);

  const handleRetry = useCallback(async (row: ExtraAgentRow) => {
    if (!row.packetId) return;
    setBusy(true);
    try {
      const result = await callRetryPacket(row.packetId, 'spawned agent row retry');
      if (result.ok) {
        void fetchData();
      } else {
        console.warn('[spawned-agents] retry failed:', result.note ?? 'Retry failed');
      }
    } finally {
      setBusy(false);
    }
  }, [fetchData]);

  const handleFocusRow = useCallback((row: ExtraAgentRow) => {
    if (typeof window !== 'undefined' && (row.packetId || row.sessionKey || row.laneId)) {
      window.dispatchEvent(new CustomEvent(FOCUS_LANE_EVENT, {
        detail: {
          packetId: row.packetId,
          sessionKey: row.sessionKey,
          laneId: row.laneId,
          title: row.name,
        },
      }));
      return;
    }
    if (row.sessionKey) onSelectSession?.(row.sessionKey);
  }, [onSelectSession]);

  useEffect(() => {
    void fetchData();
    const onLifecycle = () => { void fetchData(); };
    window.addEventListener('o8:lifecycle-reconcile', onLifecycle);
    const fallbackId = window.setInterval(fetchData, 300_000);
    return () => {
      window.removeEventListener('o8:lifecycle-reconcile', onLifecycle);
      window.clearInterval(fallbackId);
      abortRef.current?.abort();
      cancelHoverClose();
    };
  }, [cancelHoverClose, fetchData]);

  const rows = useMemo(() => buildRows(lanes, agents, rejectedPacketIds), [lanes, agents, rejectedPacketIds]);
  const visibleRows = useMemo(
    () => rows.filter((row) => (
      !(row.sessionKey && archivedSessionKeys.has(row.sessionKey))
      // Workers already nested under their orchestrator thread in the rail
      // above (ownership nesting, 2026-07-12) — never list twice.
      && !(row.packetId && hidePacketIds?.has(row.packetId))
    )),
    [rows, archivedSessionKeys, hidePacketIds],
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
          <GroupHeader label={group.label} tooltip={group.tooltip} unregistered={group.unregistered} />
          {group.rows.map((row) => (
            <ExtraAgentRowView
              key={row.key}
              row={row}
              active={Boolean(activeSessionKey && row.sessionKey === activeSessionKey)}
              busy={busy}
              onSelectSession={onSelectSession}
              onFocusRow={handleFocusRow}
              onRetryPacket={handleRetry}
              onOpenHoverCard={openHoverCard}
              onCloseHoverCard={scheduleHoverClose}
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
          canFocus={Boolean(actionMenu.row.packetId || actionMenu.row.sessionKey || actionMenu.row.laneId)}
          onClose={() => setActionMenu(null)}
          onFocus={() => {
            handleFocusRow(actionMenu.row);
            setActionMenu(null);
          }}
          onArchive={() => {
            void handleArchive(actionMenu.row);
            setActionMenu(null);
          }}
        />
      ) : null}
      {hoverCard ? (
        <SpawnedAgentHoverCard
          row={hoverCard.row}
          anchorRect={hoverCard.rect}
          onMouseEnter={cancelHoverClose}
          onMouseLeave={scheduleHoverClose}
        />
      ) : null}
    </section>
  );
}

export const AgentPanelExtraAgents = memo(AgentPanelExtraAgentsBase);
