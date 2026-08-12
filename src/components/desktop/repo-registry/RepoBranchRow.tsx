'use client';

import { memo, useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, PlayCircle } from '../lucide-shims';
import { openExternalUrl } from '@/lib/desktop/open-external';
import {
  AlertCircle,
  FolderOpen,
  GitBranch,
  RepoActionButton,
  THEME_ACCENT,
  THEME_ACCENT_BORDER,
  THEME_ACCENT_SOFT,
  THEME_SUCCESS_TEXT,
  THEME_WORKTREE_BORDER,
  THEME_WORKTREE_SOFT,
  THEME_WORKTREE_TEXT,
  Trash2,
  branchSessionLabel,
  compareBranchAgents,
  formatBranchDisplayName,
  formatCompactAge,
  orchestratorRuntimeTone,
  orchestratorStatusTone,
  packetMatchesBranch,
  resolveDisplayRuntime,
  resolveFloatingPanelPosition,
  sessionStatusTone,
  AgentSpinner,
  shortenPath,
  worktreeIsolationLabel,
  worktreeStageTone,
  type BranchAgent,
  type BranchInfo,
  type OrchestratorPacket,
  type RepoRegistryEntry,
  type WorktreeInfo,
  CodexIcon,
  ClaudeIcon,
  GeminiIcon,
  OpenCodeIcon,
} from './shared';
import { AgentStatusHover } from './AgentStatusHover';
import { AgentStatusDot, agentStatusToDotState } from '../AgentStatusDot';
import { threeWordTaskSummary } from './task-label';
import { archiveRuntimeTarget } from '@/lib/runtime/archive-client';

interface RepoBranchRowProps {
  repo: RepoRegistryEntry;
  branch: BranchInfo;
  branchAgents: BranchAgent[];
  orchestratorPackets: OrchestratorPacket[];
  allPacketBoundSessionKeys: Set<string>;
  sessionDisclosureByBranch: Record<string, boolean>;
  setSessionDisclosureByBranch: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  worktree?: WorktreeInfo | null;
  activeSessionKey?: string | null;
  activeWorkspacePath?: string | null;
  githubUrl: string | null;
  checkoutBusy: boolean;
  handleCheckout: (branch: string, opts?: { stash?: boolean; force?: boolean }) => Promise<void>;
  scheduleBranchHover: (branchName: string, element: HTMLDivElement, clientX: number, clientY: number) => void;
  holdBranchHover: () => void;
  closeBranchHover: () => void;
  hoveredBranchName: string | null;
  branchHoverRect: DOMRect | null;
  onSelectSession?: (sessionKey: string) => void;
  handleOpenDesktopPath: (editor: 'finder' | 'terminal', targetPath: string) => Promise<void>;
  handleCleanupWorktree: (worktree: WorktreeInfo) => Promise<void>;
  handleDeleteBranch: (branchName: string, force?: boolean) => Promise<void>;
  branchDeleteConfirm: string | null;
  setBranchDeleteConfirm: React.Dispatch<React.SetStateAction<string | null>>;
}

// Rams-style status row — matches RepoStatusHover's StatusRow exactly.
// Flat monochrome list item with 88px uppercase label gutter + value cell.
function BranchStatusRow({
  label,
  value,
  mono,
  tone = 'neutral',
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  tone?: 'neutral' | 'attention' | 'danger';
}) {
  const toneColor = tone === 'danger' ? '#d28787' : tone === 'attention' ? '#d4a050' : 'var(--t-text)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 4, paddingBottom: 4 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--t-text-faint)',
          width: 88,
          flexShrink: 0,
          fontFamily: 'var(--font-sans-system)',
        }}
      >
        {label}
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12.5,
          fontWeight: 460,
          color: toneColor,
          letterSpacing: '-0.005em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontFamily: mono ? '"SF Mono", ui-monospace, Menlo, monospace' : 'var(--font-sans-system)',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function RepoBranchRowBase({
  repo,
  branch,
  branchAgents,
  orchestratorPackets,
  allPacketBoundSessionKeys,
  sessionDisclosureByBranch,
  setSessionDisclosureByBranch,
  worktree,
  activeSessionKey = null,
  activeWorkspacePath = null,
  githubUrl,
  checkoutBusy,
  handleCheckout,
  scheduleBranchHover,
  holdBranchHover,
  closeBranchHover,
  hoveredBranchName,
  branchHoverRect,
  onSelectSession,
  handleOpenDesktopPath,
  handleCleanupWorktree,
  handleDeleteBranch,
  branchDeleteConfirm,
  setBranchDeleteConfirm,
}: RepoBranchRowProps) {
  // Per-row hover flag — gates the inline trash icon so it only appears on
  // the entered row instead of every sibling. Local state is fine here; the
  // hover doesn't need to coordinate across rows.
  const [rowHovered, setRowHovered] = useState(false);
  // Two-step delete confirm strip lives directly under the row. Soft-delete
  // returns `canForce: true` when the branch isn't merged → reuses the
  // existing `branchDeleteConfirm` flow. Pre-soft-delete confirm is local.
  const [pendingDelete, setPendingDelete] = useState(false);

  // ── Agent hover state — opens the AgentStatusHover popover after a short
  // dwell so flicking past agent rows doesn't flash the card. The hover
  // only tracks the currently-entered row via `hoveredAgentKey`; the rect
  // + agent reference are captured at hover-in time and frozen for the
  // duration of the hover so the card doesn't drift if the agent's status
  // updates mid-hover.
  const [hoveredAgentKey, setHoveredAgentKey] = useState<string | null>(null);
  const [hoveredAgentRect, setHoveredAgentRect] = useState<DOMRect | null>(null);
  // Optimistically hide rows the operator dismissed so the panel feels
  // instant. The server archive returns asynchronously; the next inventory
  // snapshot will reconcile this set with the live list. If the archive
  // fails the row reappears on the next snapshot, which is the right thing.
  const [dismissedSessionKeys, setDismissedSessionKeys] = useState<Set<string>>(() => new Set());
  const agentHoverOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentHoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleDismissAgent = useCallback(async (sessionKey: string) => {
    const clientMutationId = crypto.randomUUID();
    setDismissedSessionKeys((prev) => {
      if (prev.has(sessionKey)) return prev;
      const next = new Set(prev);
      next.add(sessionKey);
      return next;
    });
    try {
      await archiveRuntimeTarget({ sessionKey }, clientMutationId);
    } catch {
      // Drop the optimistic hide so the row returns and the operator can retry.
      setDismissedSessionKeys((prev) => {
        if (!prev.has(sessionKey)) return prev;
        const next = new Set(prev);
        next.delete(sessionKey);
        return next;
      });
    }
  }, []);

  const scheduleAgentHover = useCallback((key: string, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    if (agentHoverCloseTimerRef.current) {
      clearTimeout(agentHoverCloseTimerRef.current);
      agentHoverCloseTimerRef.current = null;
    }
    if (agentHoverOpenTimerRef.current) clearTimeout(agentHoverOpenTimerRef.current);
    agentHoverOpenTimerRef.current = setTimeout(() => {
      setHoveredAgentKey(key);
      setHoveredAgentRect(rect);
      agentHoverOpenTimerRef.current = null;
    }, 140);
  }, []);

  const holdAgentHover = useCallback(() => {
    if (agentHoverCloseTimerRef.current) {
      clearTimeout(agentHoverCloseTimerRef.current);
      agentHoverCloseTimerRef.current = null;
    }
  }, []);

  const closeAgentHover = useCallback(() => {
    if (agentHoverOpenTimerRef.current) {
      clearTimeout(agentHoverOpenTimerRef.current);
      agentHoverOpenTimerRef.current = null;
    }
    if (agentHoverCloseTimerRef.current) clearTimeout(agentHoverCloseTimerRef.current);
    agentHoverCloseTimerRef.current = setTimeout(() => {
      setHoveredAgentKey(null);
      setHoveredAgentRect(null);
    }, 120);
  }, []);

  const branchPackets = orchestratorPackets.filter((packet) => packetMatchesBranch(packet, repo, branch, branchAgents));
  const packetBoundSessionKeys = new Set(
    branchPackets
      .map((packet) => packet.lane?.sessionKey ?? null)
      .filter((value): value is string => Boolean(value)),
  );
  // Session keys can carry an optional "codex-owned:" prefix at different layers
  // (MCP mission state vs runtime inventory). Normalize both sides so the dedupe
  // holds across the seam. Drops the generic "Agent Waiting/Blocked" ghost rows
  // that otherwise duplicate packets already shown as named lane pills above.
  const stripSessionPrefix = (key: string) => key.replace(/^codex-owned:/, '');
  const normalizedPacketKeys = new Set<string>();
  for (const key of packetBoundSessionKeys) normalizedPacketKeys.add(stripSessionPrefix(key));
  for (const key of allPacketBoundSessionKeys) normalizedPacketKeys.add(stripSessionPrefix(key));
  const orderedBranchAgents = [...branchAgents]
    .filter((agent) => {
      if (dismissedSessionKeys.has(agent.sessionKey)) return false;
      const normalized = stripSessionPrefix(agent.sessionKey);
      if (normalizedPacketKeys.has(normalized)) return false;
      // Drop orphaned ghost agents — sessions that died without a packet binding.
      // #542 will fix the cleanup path properly; this is the narrow UI hide so the
      // sidebar doesn't show stale "Agent Waiting" rows for dead dispatches.
      if (agent.status === 'awaiting_input' || agent.status === 'failed') return false;
      return true;
    })
    .sort(compareBranchAgents);
  const sessionsExpanded = sessionDisclosureByBranch[branch.name] ?? true;
  const isActiveWorktree = Boolean(activeWorkspacePath && worktree?.path === activeWorkspacePath);
  const isActiveRootBranch = Boolean(!branch.isWorktree && branch.current && activeWorkspacePath === repo.localPath);
  const isActiveScope = isActiveWorktree || isActiveRootBranch;
  const worktreeTone = branch.isWorktree
    ? worktreeStageTone(worktree?.status ?? (branch.isStale ? 'stale' : 'ready'))
    : null;
  const canOpenPr = Boolean(
    githubUrl
    && !branch.current
    && branch.name !== repo.defaultBranch
    && branch.ahead > 0,
  );
  const branchAgentLabel = branchAgents.length === 1
    ? branchAgents[0]?.name ?? null
    : branchAgents.length > 1
      ? `${branchAgents.length} agents`
      : null;
  const branchDiffAgent = branchAgents.find((agent) => ((agent.additions ?? 0) > 0 || (agent.deletions ?? 0) > 0)) ?? null;
  const branchBaseBackground = isActiveScope ? 'rgba(37, 99, 235, 0.08)' : 'transparent';
  const branchHoverBackground = 'var(--t-panel-hover)';

  // Status indicator — a glyph column on the row's left edge:
  //   spinning braille → running agent on this branch
  //   ● solid dot      → has pending changes (additions/deletions) but idle
  //   ?                → worktree needs attention (stale, conflicts)
  //   (empty)          → clean branch, no activity
  const hasRunningAgent = branchAgents.some((a) => a.status === 'running' || a.status === 'reviewing');
  const hasChanges = (branch.additions ?? 0) > 0 || (branch.deletions ?? 0) > 0
    || (branchDiffAgent && ((branchDiffAgent.additions ?? 0) > 0 || (branchDiffAgent.deletions ?? 0) > 0));
  const needsAttention = branch.isStale || worktree?.status === 'stale';
  const branchIndicator: 'spinner' | 'dot' | 'question' | null =
    hasRunningAgent ? 'spinner'
    : needsAttention ? 'question'
    : hasChanges ? 'dot'
    : null;
  // The repo card header already shows "{repo.defaultBranch} · {status}" as
  // its subtitle. Rendering a row for the default branch at the repo root is
  // visually redundant — suppress the row header but keep any child packets
  // and sessions so they still show up (flush, without the indent rail).
  // Note: `isWorktree` is TRUE for the root checkout too (git-worktree-aware
  // API), so gate on "default branch AND lives at repo root" instead.
  const isRootDefaultBranch = branch.name === repo.defaultBranch
    && (!branch.isWorktree || branch.worktreePath === repo.localPath);
  const isRedundantDefaultBranch = isRootDefaultBranch;

  // Consolidation rule (#operator ask, May 1):
  //   The branch header row + nested agent/packet row was always two visually
  //   redundant lines. When there is exactly ONE work unit attached
  //   (1 agent + 0 packets, or 0 agents + 1 packet) we render a single line
  //   with [provider icon] [3-word description] [diff], dropping the branch
  //   header entirely. The branch name still lives in the hover card.
  const soloAgent = !isRedundantDefaultBranch
    && branchPackets.length === 0
    && orderedBranchAgents.length === 1
    ? orderedBranchAgents[0]!
    : null;
  const soloPacket = !isRedundantDefaultBranch
    && branchPackets.length === 1
    && orderedBranchAgents.length === 0
    ? branchPackets[0]!
    : null;
  const consolidated = Boolean(soloAgent || soloPacket);

  // Diff figures, hoisted so the consolidated row can render them next to the
  // agent label. Prefer agent in-progress diff, fallback to branch divergence.
  const consolidatedAdds = branchDiffAgent?.additions ?? branch.additions ?? 0;
  const consolidatedDels = branchDiffAgent?.deletions ?? branch.deletions ?? 0;

  if (consolidated) {
    const targetSessionKey = soloAgent?.sessionKey
      ?? soloPacket?.lane?.sessionKey
      ?? null;
    const runtime = soloAgent?.runtime
      ?? (soloPacket ? resolveDisplayRuntime(soloPacket) : 'codex');
    const label = soloAgent
      ? (soloAgent.status === 'running' || soloAgent.status === 'reviewing'
          ? threeWordTaskSummary(soloAgent.currentTask) ?? soloAgent.name
          : soloAgent.name)
      : threeWordTaskSummary(soloPacket!.title) ?? soloPacket!.title;
    const secondary = soloAgent
      ? sessionStatusTone(soloAgent.status).label
      : orchestratorStatusTone(soloPacket!.status).label;
    const isSelected = Boolean(
      activeSessionKey
      && targetSessionKey
      && activeSessionKey === targetSessionKey,
    );
    const indicatorStatus = soloAgent?.status ?? 'queued';
    return (
      <div>
        <button
          type="button"
          disabled={!targetSessionKey || !onSelectSession}
          onClick={(event) => {
            event.stopPropagation();
            if (targetSessionKey) onSelectSession?.(targetSessionKey);
          }}
          onMouseEnter={(event) => {
            const el = event.currentTarget;
            el.style.background = isSelected ? 'var(--t-accent-soft)' : 'var(--t-panel-hover)';
            setRowHovered(true);
            scheduleBranchHover(branch.name, el as unknown as HTMLDivElement, event.clientX, event.clientY);
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = isSelected ? 'var(--t-accent-soft)' : 'transparent';
            setRowHovered(false);
            closeBranchHover();
          }}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '5px 8px',
            borderRadius: 7,
            border: 'none',
            background: isSelected ? 'var(--t-accent-soft)' : 'transparent',
            color: 'var(--t-text)',
            cursor: targetSessionKey && onSelectSession ? 'pointer' : 'default',
            fontFamily: 'var(--font-sans-system)',
            textAlign: 'left',
            transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          <span style={{ width: 12, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginTop: 2 }}>
            <AgentSpinner status={indicatorStatus} size={6} />
          </span>
          {runtime === 'claude-code' ? <ClaudeIcon size={13} />
            : runtime === 'gemini' ? <GeminiIcon size={13} />
            : runtime === 'opencode' ? <OpenCodeIcon size={13} />
            : <CodexIcon size={13} />}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 }}>
            <span
              style={{
                fontSize: 12,
                fontWeight: 460,
                color: isSelected ? 'var(--t-accent)' : 'var(--t-text)',
                letterSpacing: '-0.005em',
                lineHeight: 1.35,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {label}
            </span>
            <span
              style={{
                fontSize: 10,
                fontWeight: 400,
                color: 'var(--t-text-faint)',
                letterSpacing: '-0.005em',
                lineHeight: 1.3,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {secondary}
              {' · '}
              {formatBranchDisplayName(branch.name)}
            </span>
          </div>
          {(consolidatedAdds > 0 || consolidatedDels > 0) ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 10.5,
                fontWeight: 440,
                fontFamily: 'var(--font-sans-system)',
                letterSpacing: '-0.005em',
                flexShrink: 0,
                marginTop: 1,
              }}
            >
              <span style={{ color: '#4ea672' }}>+{consolidatedAdds.toLocaleString()}</span>
              <span style={{ color: '#c97070' }}>-{consolidatedDels.toLocaleString()}</span>
            </span>
          ) : null}
        </button>
        {hoveredBranchName === branch.name && branchHoverRect && typeof document !== 'undefined' ? createPortal(
          <div
            onMouseEnter={holdBranchHover}
            onMouseLeave={closeBranchHover}
            style={{
              position: 'fixed',
              zIndex: 10000,
              width: 320,
              padding: '14px 16px 12px',
              borderRadius: 12,
              border: '1px solid var(--t-panel-border)',
              background: 'var(--t-panel-solid)',
              boxShadow: 'var(--t-panel-shadow), 0 8px 32px rgba(15, 23, 42, 0.18)',
              color: 'var(--t-text)',
              pointerEvents: 'auto',
              fontFamily: 'var(--font-sans-system)',
              ...resolveFloatingPanelPosition(branchHoverRect, 320),
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 10 }}>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  letterSpacing: '-0.012em',
                  color: 'var(--t-text)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
                }}
              >
                {branch.name}
              </div>
              <div style={{ fontSize: 11, color: 'var(--t-text-faint)' }}>
                {branch.isWorktree ? `${worktreeTone?.label ?? 'Worktree'} · ${worktreeIsolationLabel(worktree)}` : branch.current ? 'Current branch' : 'Branch'}
                {worktree?.path ? ` · ${shortenPath(worktree.path)}` : ''}
              </div>
            </div>
            <BranchStatusRow label="Last commit" value={branch.lastCommitAge} />
            {(consolidatedAdds > 0 || consolidatedDels > 0) ? (
              <BranchStatusRow
                label="Diff"
                value={`+${consolidatedAdds.toLocaleString()} -${consolidatedDels.toLocaleString()}`}
                mono
              />
            ) : null}
          </div>,
          document.body,
        ) : null}
      </div>
    );
  }

  return (
    <div>
      {isRedundantDefaultBranch ? null : (
      <div
        onClick={() => {
          // For any branch (worktree or not), try to open the agent transcript first
          const packetSession = branchPackets.find((packet) => packet.lane?.sessionKey)?.lane?.sessionKey;
          const agentSession = branchAgents[0]?.sessionKey;

          if (branch.isWorktree) {
            const wtPath = branch.worktreePath ?? worktree?.path;
            const pathMatchedPacket = !packetSession && wtPath
              ? orchestratorPackets.find((packet) => packet.lane?.sessionKey && packet.lane.worktreePath === wtPath)
              : null;
            const sessionKey = packetSession ?? pathMatchedPacket?.lane?.sessionKey ?? agentSession;
            if (sessionKey && onSelectSession) {
              onSelectSession(sessionKey);
              return;
            }
            if (wtPath && onSelectSession) {
              void fetch('/api/lanes?active=true')
                .then((response) => response.json())
                .then((data: { lanes?: Array<{ worktreePath?: string; sessionKey?: string }> }) => {
                  const lane = data.lanes?.find((entry) => entry.worktreePath === wtPath && entry.sessionKey);
                  if (lane?.sessionKey) onSelectSession(lane.sessionKey);
                })
                .catch(() => {});
              return;
            }
          } else {
            // Non-worktree branch: open agent transcript if one exists
            const sessionKey = packetSession ?? agentSession;
            if (sessionKey && onSelectSession) {
              onSelectSession(sessionKey);
              return;
            }
          }

          if (!branch.current && !checkoutBusy) {
            void handleCheckout(branch.name);
          }
        }}
        onMouseEnter={(event) => {
          const target = event.currentTarget as HTMLDivElement;
          target.style.background = branchHoverBackground;
          setRowHovered(true);
          scheduleBranchHover(branch.name, target, event.clientX, event.clientY);
        }}
        onMouseLeave={(event) => {
          (event.currentTarget as HTMLDivElement).style.background = branchBaseBackground;
          setRowHovered(false);
          closeBranchHover();
        }}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 9,
          padding: '5px 8px',
          borderRadius: 7,
          background: branchBaseBackground,
          border: 'none',
          cursor: branch.current ? 'default' : checkoutBusy ? 'wait' : 'pointer',
          transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        {/* Status indicator — fixed-width slot to the left of the branch
            icon. Always reserves 12px so the branch name never shifts
            horizontally when an indicator appears or disappears. */}
        <span
          style={{
            width: 12,
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: 2,
          }}
        >
          {branchIndicator === 'spinner' ? (
            <AgentSpinner status="running" size={6} />
          ) : branchIndicator === 'dot' ? (
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: '#d4a050',
              }}
            />
          ) : branchIndicator === 'question' ? (
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: '#d4a050',
                lineHeight: 1,
              }}
            >
              ?
            </span>
          ) : null}
        </span>
        <GitBranch
          size={12}
          strokeWidth={2}
          style={{
            flexShrink: 0,
            color: isActiveScope ? THEME_ACCENT : branch.current ? THEME_SUCCESS_TEXT : branch.isWorktree ? THEME_WORKTREE_TEXT : 'var(--t-text-muted)',
            marginTop: branch.isWorktree ? 2 : 1,
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 440,
              color: 'var(--t-text)',
              fontFamily: 'var(--font-sans-system)',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              lineHeight: 1.35,
              letterSpacing: '-0.005em',
            }}
          >
            {formatBranchDisplayName(branch.name)}
          </span>
          <span
            style={{
              fontSize: 10,
              lineHeight: 1.3,
              fontWeight: 400,
              color: 'var(--t-text-faint)',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              letterSpacing: '-0.005em',
            }}
          >
            {formatCompactAge(branch.lastCommitUnix)}
          </span>
        </div>
        {isActiveScope ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '2px 7px',
              borderRadius: 999,
              background: THEME_ACCENT_SOFT,
              border: `1px solid ${THEME_ACCENT_BORDER}`,
              color: THEME_ACCENT,
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              flexShrink: 0,
              marginTop: branch.isWorktree ? 0 : 1,
            }}
          >
            Current
          </span>
        ) : null}
        {(() => {
          // Prefer a live agent's in-progress diff (more informative while an
          // agent is working), otherwise fall back to the branch-level diff
          // vs the repo's default branch.
          const adds = branchDiffAgent?.additions ?? branch.additions ?? 0;
          const dels = branchDiffAgent?.deletions ?? branch.deletions ?? 0;
          if (adds === 0 && dels === 0) return null;
          return (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 10.5,
                fontWeight: 440,
                fontFamily: 'var(--font-sans-system)',
                letterSpacing: '-0.005em',
                flexShrink: 0,
                marginTop: 1,
              }}
            >
              <span style={{ color: '#4ea672' }}>+{adds.toLocaleString()}</span>
              <span style={{ color: '#c97070' }}>-{dels.toLocaleString()}</span>
            </span>
          );
        })()}

        {/* Hover-revealed trash — manual prune for any branch the API kept
            (e.g. unmerged branches still showing). Hidden on the current
            branch + default branch (protected). 44pt minimum touch target
            via the wrapper button; the icon itself is 12px to keep the row
            compact. Click → pendingDelete strip; Confirm → handleDeleteBranch
            (which itself escalates to force-delete via the existing
            branchDeleteConfirm strip if the branch isn't merged). */}
        {!branch.current && branch.name !== repo.defaultBranch ? (
          <button
            type="button"
            aria-label={`Delete ${branch.name}`}
            title={`Delete ${branch.name}`}
            onClick={(event) => {
              event.stopPropagation();
              setPendingDelete(true);
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 44,
              height: 44,
              marginTop: -14,
              marginBottom: -14,
              marginRight: -10,
              flexShrink: 0,
              border: 'none',
              background: 'transparent',
              color: 'var(--t-text-faint)',
              cursor: 'pointer',
              opacity: rowHovered ? 1 : 0,
              // Pop curve for the hover-reveal — matches SessionPillContextMenu,
              // RejectedFeedbackPanel, setup-wizard atoms. Subtle overshoot so
              // the trash icon "appears" rather than fades, signalling that the
              // affordance is intentional and clickable. (#720)
              transition: 'opacity 220ms cubic-bezier(0.34, 1.36, 0.64, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
            onMouseEnter={(event) => {
              (event.currentTarget as HTMLButtonElement).style.color = '#c97070';
            }}
            onMouseLeave={(event) => {
              (event.currentTarget as HTMLButtonElement).style.color = 'var(--t-text-faint)';
            }}
          >
            <Trash2 size={12} strokeWidth={2} />
          </button>
        ) : null}
      </div>
      )}

      {pendingDelete ? (
        <div
          style={{
            marginLeft: 36,
            marginTop: 4,
            marginBottom: 4,
            paddingTop: 6,
            paddingBottom: 6,
            paddingLeft: 8,
            paddingRight: 8,
            borderRadius: 8,
            border: '1px solid rgba(239,68,68,0.15)',
            background: 'rgba(254,242,242,0.9)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <AlertCircle size={11} strokeWidth={2} style={{ color: '#dc2626', flexShrink: 0 }} />
          <span style={{ fontSize: 10, color: '#991b1b', flex: 1 }}>
            Delete {branch.isWorktree ? 'worktree + branch' : 'branch'} {branch.name}?
          </span>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setPendingDelete(false);
            }}
            style={{
              fontSize: 10,
              fontWeight: 500,
              color: 'var(--t-text-muted)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '2px 6px',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setPendingDelete(false);
              if (worktree?.status === 'stale') {
                void handleCleanupWorktree(worktree);
                return;
              }
              void handleDeleteBranch(branch.name);
            }}
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: '#dc2626',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '2px 6px',
            }}
          >
            Delete
          </button>
        </div>
      ) : null}

      {branchPackets.length > 0 || orderedBranchAgents.length > 0 ? (
        <div
          style={{
            marginLeft: isRedundantDefaultBranch ? 0 : 22,
            marginTop: isRedundantDefaultBranch ? 0 : 2,
            marginBottom: isRedundantDefaultBranch ? 0 : 4,
            paddingLeft: isRedundantDefaultBranch ? 0 : 10,
            borderLeft: isRedundantDefaultBranch ? 'none' : '1px solid var(--t-divider-subtle)',
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
          }}
        >
          {branchPackets.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {branchPackets.map((packet) => {
                const displayRuntime = resolveDisplayRuntime(packet);
                const runtimeTone = orchestratorRuntimeTone(displayRuntime);
                const statusTone = orchestratorStatusTone(packet.status);
                const isSelectedPacket = Boolean(packet.lane?.sessionKey && packet.lane.sessionKey === activeSessionKey);
                const marker = packet.releaseState === 'released'
                  ? 'Released'
                  : packet.blockedReason
                    ? 'Blocked'
                    : packet.status === 'awaiting_review'
                      ? 'Review'
                      : packet.dependencyLabels[0] ?? null;
                return (
                  <button
                    key={packet.id}
                    type="button"
                    disabled={!packet.lane?.sessionKey || !onSelectSession}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (packet.lane?.sessionKey) {
                        onSelectSession?.(packet.lane.sessionKey);
                      }
                    }}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 9,
                      paddingTop: 5,
                      paddingRight: 8,
                      paddingBottom: 5,
                      paddingLeft: 8,
                      borderRadius: 7,
                      border: 'none',
                      background: isSelectedPacket ? THEME_ACCENT_SOFT : 'transparent',
                      color: 'var(--t-text)',
                      cursor: packet.lane?.sessionKey && onSelectSession ? 'pointer' : 'default',
                      fontFamily: 'var(--font-sans-system)',
                      textAlign: 'left',
                      transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                      opacity: packet.lane?.sessionKey && onSelectSession ? 1 : 0.82,
                    }}
                    onMouseEnter={(event) => {
                      if (!isSelectedPacket) {
                        event.currentTarget.style.background = 'var(--t-panel-hover)';
                      }
                    }}
                    onMouseLeave={(event) => {
                      if (!isSelectedPacket) {
                        event.currentTarget.style.background = 'transparent';
                      }
                    }}
                  >
                    {/* 12px indicator slot — keeps packet cards aligned with
                        branch rows that have the same reserved column. */}
                    <span style={{ width: 12, flexShrink: 0 }} />
                    <span
                      title={runtimeTone.label}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 14,
                        height: 14,
                        flexShrink: 0,
                        marginTop: 1,
                      }}
                    >
                      {displayRuntime === 'claude-code' ? <ClaudeIcon size={13} />
                        : displayRuntime === 'gemini' ? <GeminiIcon size={13} />
                        : displayRuntime === 'opencode' ? <OpenCodeIcon size={13} />
                        : <CodexIcon size={13} />}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                        <span
                          style={{
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            fontSize: 12,
                            fontWeight: 440,
                            color: 'var(--t-text)',
                            letterSpacing: '-0.005em',
                            lineHeight: 1.35,
                            fontFamily: 'var(--font-sans-system)',
                          }}
                        >
                          {packet.title}
                        </span>
                      </span>
                      <span
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 5,
                          marginTop: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis',
                          fontSize: 10.5,
                          lineHeight: 1.3,
                          color: 'var(--t-text-faint)',
                        }}
                      >
                        <span>{runtimeTone.label}</span>
                        <span>·</span>
                        <span>{statusTone.label}</span>
                        {marker ? (
                          <>
                            <span>·</span>
                            <span>{marker}</span>
                          </>
                        ) : null}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {orderedBranchAgents.length > 0 ? (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {orderedBranchAgents.map((agent) => {
                    const statusTone = sessionStatusTone(agent.status);
                    const isSelectedSession = activeSessionKey === agent.sessionKey;
                    // Prefer a 3-word task summary when the agent is actively
                    // working — "Editing NavRail now" beats "Working" when 30
                    // rows would otherwise say the same thing. Falls back to
                    // the status label when idle / blocked / no task known.
                    const isActive = agent.status === 'running' || agent.status === 'reviewing';
                    const taskSummary = isActive ? threeWordTaskSummary(agent.currentTask) : null;
                    const secondaryLabel = taskSummary ?? statusTone.label;
                    const isHoveredAgent = hoveredAgentKey === agent.sessionKey;
                    const canDismiss = (
                      agent.sessionKey.startsWith('codex-owned:')
                      || agent.sessionKey.startsWith('gemini-owned:')
                      || agent.sessionKey.startsWith('opencode-owned:')
                    );
                    return (
                      <div
                        key={agent.sessionKey}
                        role="button"
                        tabIndex={onSelectSession ? 0 : -1}
                        aria-disabled={!onSelectSession}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelectSession?.(agent.sessionKey);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            onSelectSession?.(agent.sessionKey);
                          }
                        }}
                        onMouseEnter={(event) => {
                          scheduleAgentHover(agent.sessionKey, event.currentTarget);
                        }}
                        onMouseLeave={() => {
                          closeAgentHover();
                        }}
                        style={{
                          width: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 9,
                          padding: '5px 8px',
                          borderRadius: 7,
                          border: 'none',
                          background: isSelectedSession ? 'var(--t-accent-soft)' : 'transparent',
                          color: 'var(--t-text)',
                          cursor: onSelectSession ? 'pointer' : 'default',
                          fontFamily: 'var(--font-sans-system)',
                          textAlign: 'left',
                          transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                        }}
                      >
                        <span style={{ width: 12, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginTop: 2 }}>
                          <AgentStatusDot state={agentStatusToDotState(agent.status)} />
                        </span>
                        {agent.runtime === 'claude-code' ? <ClaudeIcon size={12} />
                          : agent.runtime === 'gemini' ? <GeminiIcon size={12} />
                          : agent.runtime === 'opencode' ? <OpenCodeIcon size={12} />
                          : <CodexIcon size={12} />}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 }}>
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: 440,
                              color: isSelectedSession ? 'var(--t-accent)' : 'var(--t-text)',
                              letterSpacing: '-0.005em',
                              lineHeight: 1.35,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {branchSessionLabel(agent)}
                          </span>
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 400,
                              color: statusTone.color,
                              letterSpacing: '-0.005em',
                              lineHeight: 1.3,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {secondaryLabel}
                          </span>
                        </div>
                        {canDismiss && isHoveredAgent ? (
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label="Dismiss agent"
                            title="Remove this session from the panel"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleDismissAgent(agent.sessionKey);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                event.stopPropagation();
                                void handleDismissAgent(agent.sessionKey);
                              }
                            }}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: 16,
                              height: 16,
                              flexShrink: 0,
                              borderRadius: 4,
                              color: 'var(--t-text-faint)',
                              cursor: 'pointer',
                              opacity: 0.7,
                              transition: 'opacity 120ms cubic-bezier(0.22, 1, 0.36, 1), background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                            }}
                            onMouseEnter={(event) => {
                              event.currentTarget.style.opacity = '1';
                              event.currentTarget.style.background = 'rgba(148, 163, 184, 0.18)';
                            }}
                            onMouseLeave={(event) => {
                              event.currentTarget.style.opacity = '0.7';
                              event.currentTarget.style.background = 'transparent';
                            }}
                          >
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                              <path d="M2 2 L8 8 M8 2 L2 8" />
                            </svg>
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
            </>
          ) : null}
        </div>
      ) : null}

      {hoveredBranchName === branch.name && branchHoverRect && typeof document !== 'undefined' ? createPortal(
        <div
          onMouseEnter={holdBranchHover}
          onMouseLeave={closeBranchHover}
          style={{
            position: 'fixed',
            zIndex: 10000,
            width: 320,
            padding: '14px 16px 12px',
            borderRadius: 12,
            border: '1px solid var(--t-panel-border)',
            background: 'var(--t-panel-solid)',
            boxShadow: 'var(--t-panel-shadow), 0 8px 32px rgba(15, 23, 42, 0.18)',
            color: 'var(--t-text)',
            pointerEvents: 'auto',
            fontFamily: 'var(--font-sans-system)',
            ...resolveFloatingPanelPosition(branchHoverRect, 320),
          }}
        >
          {/* Header — branch name + muted classification + commit message */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 10 }}>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                letterSpacing: '-0.012em',
                color: 'var(--t-text)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
              }}
            >
              {branch.name}
            </div>
            <div
              style={{
                fontSize: 11,
                color: 'var(--t-text-faint)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                letterSpacing: '-0.002em',
              }}
            >
              {branch.isWorktree ? `${worktreeTone?.label ?? 'Worktree'} · ${worktreeIsolationLabel(worktree)}` : branch.current ? 'Current branch' : 'Branch'}
              {worktree?.path ? ` · ${shortenPath(worktree.path)}` : ''}
            </div>
            {branch.lastCommitMessage ? (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 11.5,
                  lineHeight: 1.4,
                  color: 'var(--t-text-secondary)',
                  letterSpacing: '-0.003em',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {branch.lastCommitMessage}
              </div>
            ) : null}
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: 'var(--t-divider-subtle)', margin: '2px -16px 6px' }} />

          {/* Status rows — same pattern as repo hover */}
          <BranchStatusRow label="Last commit" value={branch.lastCommitAge} />
          {branchDiffAgent ? (
            <BranchStatusRow
              label="Working tree"
              value={`+${(branchDiffAgent.additions ?? 0).toLocaleString()} -${(branchDiffAgent.deletions ?? 0).toLocaleString()}`}
              mono
            />
          ) : null}
          {(branch.ahead > 0 || branch.behind > 0) ? (
            <BranchStatusRow
              label="Upstream"
              value={`${branch.ahead > 0 ? `↑${branch.ahead}` : ''}${branch.ahead > 0 && branch.behind > 0 ? ' ' : ''}${branch.behind > 0 ? `↓${branch.behind}` : ''}`}
              mono
              tone={branch.behind > 0 ? 'attention' : 'neutral'}
            />
          ) : null}
          {branch.diskSize ? (
            <BranchStatusRow label="Disk" value={branch.diskSize} mono />
          ) : null}
          {worktree ? (
            <BranchStatusRow
              label="Isolation"
              value={worktree.status === 'stale' ? 'Needs cleanup' : worktreeIsolationLabel(worktree)}
              tone={worktree.status === 'stale' ? 'attention' : 'neutral'}
            />
          ) : null}
          {branchAgents.length > 0 ? (
            <BranchStatusRow
              label="Agents"
              value={(
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  {branchAgents.map((agent) => (
                    <span
                      key={agent.sessionKey}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    >
                      {agent.runtime === 'claude-code' ? <ClaudeIcon size={11} color={agent.color} />
                        : agent.runtime === 'gemini' ? <GeminiIcon size={11} />
                        : agent.runtime === 'opencode' ? <OpenCodeIcon size={11} />
                        : <CodexIcon size={11} color={agent.color} />}
                      <span style={{ fontSize: 11.5, color: 'var(--t-text)' }}>{agent.name}</span>
                    </span>
                  ))}
                </div>
              )}
            />
          ) : null}
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--t-divider-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>
              {branch.current ? 'Current branch' : 'Click row to switch'}
            </span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {branchAgents.map((agent) => (
                onSelectSession ? (
                  <RepoActionButton
                    key={agent.sessionKey}
                    label={`Open ${agent.name}`}
                    icon={<PlayCircle size={12} strokeWidth={2} />}
                    onClick={() => onSelectSession(agent.sessionKey)}
                  />
                ) : null
              ))}
              {worktree ? (
                <RepoActionButton
                  label="Open workspace"
                  icon={<FolderOpen size={12} strokeWidth={2} />}
                  onClick={() => { void handleOpenDesktopPath('finder', worktree.path); }}
                />
              ) : null}
              {canOpenPr ? (
                <RepoActionButton
                  label="Open PR"
                  icon={<ExternalLink size={12} strokeWidth={2} />}
                  onClick={() => openExternalUrl(`${githubUrl}/compare/${branch.name}?expand=1`)}
                  active
                />
              ) : null}
              {!branch.current ? (
                <RepoActionButton
                  label={worktree?.status === 'stale' ? 'Clean up worktree' : branch.isWorktree ? 'Delete worktree' : 'Delete branch'}
                  icon={<Trash2 size={12} strokeWidth={2} />}
                  onClick={() => {
                    if (worktree?.status === 'stale') {
                      void handleCleanupWorktree(worktree);
                      return;
                    }
                    void handleDeleteBranch(branch.name);
                  }}
                  danger
                />
              ) : null}
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {branchDeleteConfirm === branch.name ? (
        <div
          style={{
            marginLeft: 36,
            marginBottom: 4,
            padding: '6px 8px',
            borderRadius: 8,
            border: '1px solid rgba(239,68,68,0.15)',
            background: 'rgba(254,242,242,0.9)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <AlertCircle size={11} strokeWidth={2} style={{ color: '#dc2626', flexShrink: 0 }} />
          <span style={{ fontSize: 10, color: '#991b1b', flex: 1 }}>Not fully merged.</span>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void handleDeleteBranch(branch.name, true);
            }}
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: '#dc2626',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '2px 6px',
            }}
          >
            Force delete
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setBranchDeleteConfirm(null);
            }}
            style={{
              fontSize: 10,
              fontWeight: 500,
              color: 'var(--t-text-muted)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '2px 6px',
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}

      {hoveredAgentKey && hoveredAgentRect ? (() => {
        const hoveredAgent = orderedBranchAgents.find((agent) => agent.sessionKey === hoveredAgentKey);
        if (!hoveredAgent) return null;
        return (
          <AgentStatusHover
            agent={hoveredAgent}
            anchorRect={hoveredAgentRect}
            worktreePath={worktree?.path ?? (branch.isWorktree ? branch.worktreePath ?? null : null)}
            baseBranch={worktree?.baseBranch ?? repo.defaultBranch}
            onMouseEnter={holdAgentHover}
            onMouseLeave={closeAgentHover}
          />
        );
      })() : null}
    </div>
  );
}

export const RepoBranchRow = memo(RepoBranchRowBase);
