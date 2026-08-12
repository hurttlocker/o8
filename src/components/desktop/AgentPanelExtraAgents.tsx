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
 * Rows are flat across repositories: attention rank first, then recency.
 * A repo suffix appears only when more than one repository is represented.
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
import { motion } from 'framer-motion';
import { deriveParkedLaneBuckets, type ReviewApprovalSummary } from '@/components/desktop/merge-beacon/derive';
import { AGENT_STATUS_ACCENT } from '@/components/desktop/AgentStatusDot';
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
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { archiveRuntimeTarget } from '@/lib/runtime/archive-client';
import { SectionLabel } from './repo-focus/tabs/chats/shared';
import {
  attentionBand,
  attentionRank,
  deriveShowRepoSuffix,
  isCompletionUnread,
  repoSuffix,
  SIDEBAR_HOVER_THREAD_EVENT,
} from './repo-focus/tabs/chats/sections';
import { getLastVisited, markVisited } from './repo-focus/tabs/chats/read-state';

// ── Types ──

type LaneOwnership = 'managed' | 'attached';

export interface LaneSummary {
  id: string;
  label: string;
  repoPath: string;
  branch: string;
  runtime: OrchestratorRuntime;
  sessionKey: string | null;
  packetId: string | null;
  status: LaneStatus;
  outcome?: 'no_changes' | 'merged' | 'discarded' | 'pr_opened' | 'asked' | null;
  outcomeNote?: string | null;
  ownership: LaneOwnership;
  lastEventAt: string | null;
  lastEventLabel: string | null;
  prNumber?: number | null;
}

type AgentStatus = 'idle' | 'running' | 'blocked' | 'waiting' | 'reviewing' | 'failed' | 'completed';

export interface AgentSummary {
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

export interface AgentPanelExtraAgentsProps {
  activeSessionKey?: string | null;
  onSelectSession?: (sessionKey: string) => void;
}

// ── Constants ──

const FOCUS_LANE_EVENT = 'o8:focus-spawned-agent-lane';
const RECENT_TERMINAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_TERMINAL_CAP = 8;

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
      prNumber: lane.prNumber ?? null,
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

function isTerminalRow(row: ExtraAgentRow): boolean {
  return Boolean(row.outcome)
    || row.laneStatus === 'archived'
    || row.laneStatus === 'completed'
    || row.laneStatus === 'merged'
    || row.laneStatus === 'released';
}

export function deriveSpawnedAgentRows({
  lanes,
  agents,
  rejectedPacketIds = new Set<string>(),
  archivedSessionKeys = new Set<string>(),
  archivedRowKeys = new Set<string>(),
}: {
  lanes: LaneSummary[];
  agents: AgentSummary[];
  rejectedPacketIds?: ReadonlySet<string>;
  archivedSessionKeys?: ReadonlySet<string>;
  archivedRowKeys?: ReadonlySet<string>;
}): ExtraAgentRow[] {
  const rows = buildRows(lanes, agents, rejectedPacketIds).filter((row) => (
    !archivedRowKeys.has(row.key)
    && !(row.sessionKey && archivedSessionKeys.has(row.sessionKey))
  ));
  const live = rows.filter((row) => !isTerminalRow(row));
  const terminal = rows
    .filter(isTerminalRow)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, RECENT_TERMINAL_CAP);
  return [...live, ...terminal];
}

// ── Main component ──

const COLLAPSED_KEY = 'o8:agent-panel:spawned-agents-collapsed';

function AgentPanelExtraAgentsBase({ activeSessionKey, onSelectSession }: AgentPanelExtraAgentsProps) {
  const [lanes, setLanes] = useState<LaneSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [rejectedPacketIds, setRejectedPacketIds] = useState<Set<string>>(() => new Set());
  const [actionMenu, setActionMenu] = useState<ExtraAgentActionMenuState | null>(null);
  const [archivedRowKeys, setArchivedRowKeys] = useState<Set<string>>(() => new Set());
  const [hoverCard, setHoverCard] = useState<{ row: ExtraAgentRow; rect: DOMRect } | null>(null);
  const [busy, setBusy] = useState(false);
  const [readStateVersion, setReadStateVersion] = useState(0);
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
    if (!row.sessionKey && !row.laneId) return;
    const clientMutationId = crypto.randomUUID();
    setArchivedRowKeys((prev) => {
      if (prev.has(row.key)) return prev;
      const next = new Set(prev);
      next.add(row.key);
      return next;
    });
    setBusy(true);
    try {
      await archiveRuntimeTarget(
        row.sessionKey ? { sessionKey: row.sessionKey } : { laneId: row.laneId! },
        clientMutationId,
      );
    } catch {
      // Roll back the optimistic hide so operator can retry.
      setArchivedRowKeys((prev) => {
        if (!prev.has(row.key)) return prev;
        const next = new Set(prev);
        next.delete(row.key);
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
      const [lanesRes, snapshotRes, approvalsRes] = await Promise.allSettled([
        // Pull terminal rows too, then retain only the explicit no-change
        // terminal outcome alongside live rows. A completed no-op must remain
        // visible without flooding the rail with the full archive backlog.
        fetch('/api/lanes?active=false', { signal: controller.signal }),
        fetch('/api/command-center/snapshot', { signal: controller.signal }),
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
    } catch {
      // AbortError on teardown — silently ignore.
    }
  }, []);

  const handleRetry = useCallback(async (row: ExtraAgentRow) => {
    if (!row.packetId) return;
    setBusy(true);
    let receiptUnsettled = false;
    try {
      const result = await callRetryPacket(row.packetId, 'spawned agent row retry');
      receiptUnsettled = result.unsettled === true;
      if (result.ok) {
        void fetchData();
      } else {
        console.warn('[spawned-agents] retry failed:', result.note ?? 'Retry failed');
      }
    } finally {
      if (!receiptUnsettled) setBusy(false);
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

  const rows = useMemo(() => deriveSpawnedAgentRows({
    lanes,
    agents,
    rejectedPacketIds,
    archivedRowKeys,
  }), [lanes, agents, rejectedPacketIds, archivedRowKeys]);
  const showRepoSuffix = deriveShowRepoSuffix(rows);
  const rankedRows = useMemo(() => {
    void readStateVersion;
    return rows.map((row) => {
      const unread = row.packetId
        ? isCompletionUnread(row.lastActivityAt, getLastVisited(`packet:${row.packetId}`))
        : false;
      const subject = {
        status: row.laneStatus ?? row.status,
        rejected: row.rejected,
        outcome: row.outcome,
        unread,
      };
      return {
        row,
        band: attentionBand(subject),
        rank: attentionRank(subject),
      };
    }).sort((a, b) => b.rank - a.rank || b.row.lastActivityAt - a.row.lastActivityAt);
  }, [readStateVersion, rows]);
  const needsYouCount = rankedRows.filter((entry) => entry.rank > 0).length;
  const highestBand = rankedRows.find((entry) => entry.rank > 0)?.band ?? null;
  // Tone ladder mirrors attentionWashStyle — 'human' is warm like rejected,
  // never slate, so the header count always matches the loudest wash below it.
  const countTone = highestBand === 'failed'
    ? AGENT_STATUS_ACCENT.failed
    : highestBand === 'rejected' || highestBand === 'human'
      ? AGENT_STATUS_ACCENT.rejected
      : highestBand === 'review'
        ? AGENT_STATUS_ACCENT.review
        : highestBand === 'merged'
          ? AGENT_STATUS_ACCENT.merged
          : undefined;

  useEffect(() => {
    const onFocus = (event: Event) => {
      const detail = (event as CustomEvent<{ packetId?: string | null }>).detail;
      if (!detail?.packetId) return;
      markVisited(`packet:${detail.packetId}`);
      setReadStateVersion((current) => current + 1);
    };
    window.addEventListener(FOCUS_LANE_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_LANE_EVENT, onFocus);
  }, []);

  // Fleet reveal: a hovered orchestrator thread broadcasts its packet ids;
  // those rows light up, everything else dims (see ExtraAgentRowView's link).
  const [linkedPacketIds, setLinkedPacketIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    const onHoverThread = (event: Event) => {
      const detail = (event as CustomEvent<{ packetIds?: string[] | null }>).detail;
      setLinkedPacketIds(detail?.packetIds?.length ? new Set(detail.packetIds) : null);
    };
    window.addEventListener(SIDEBAR_HOVER_THREAD_EVENT, onHoverThread);
    return () => window.removeEventListener(SIDEBAR_HOVER_THREAD_EVENT, onHoverThread);
  }, []);

  useEffect(() => {
    if (!activeSessionKey) return;
    const activeRow = rows.find((row) => row.sessionKey === activeSessionKey);
    if (!activeRow?.packetId) return;
    markVisited(`packet:${activeRow.packetId}`);
    setReadStateVersion((current) => current + 1);
  }, [activeSessionKey, rows]);

  if (rankedRows.length === 0) return null;

  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        paddingBottom: 8,
      }}
    >
      <SectionLabel
        label="Agents"
        compact
        count={needsYouCount > 0 ? needsYouCount : undefined}
        countTone={countTone}
        collapsed={collapsed}
        onToggle={toggleCollapsed}
      />
      {/* layout="position" springs a row to its new slot when a band change
          re-sorts the list — without it, a working row that flips to needs-you
          teleports (rig finding 2026-07-31). Position-only: rows never resize. */}
      {!collapsed ? rankedRows.map(({ row, band }) => (
        <motion.div
          key={row.key}
          layout="position"
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        >
        <ExtraAgentRowView
          row={row}
          band={band}
          link={linkedPacketIds
            ? (row.packetId && linkedPacketIds.has(row.packetId) ? 'linked' : 'dimmed')
            : null}
          repoLabel={showRepoSuffix ? repoSuffix({ repoPath: row.repoPath }) : null}
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
        </motion.div>
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
