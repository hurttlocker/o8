'use client';

import { memo } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, ExternalLink, PlayCircle } from '../lucide-shims';
import {
  AlertCircle,
  FolderOpen,
  GitBranch,
  RepoActionButton,
  THEME_ACCENT,
  THEME_ACCENT_BORDER,
  THEME_ACCENT_RING,
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
  resolveFloatingPanelPosition,
  sessionStatusTone,
  AgentSpinner,
  shortenPath,
  worktreeStageTone,
  type BranchAgent,
  type BranchInfo,
  type OrchestratorPacket,
  type RepoRegistryEntry,
  type WorktreeInfo,
  CodexIcon,
  ClaudeIcon,
} from './shared';

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
  const branchPackets = orchestratorPackets.filter((packet) => packetMatchesBranch(packet, repo, branch, branchAgents));
  const packetBoundSessionKeys = new Set(
    branchPackets
      .map((packet) => packet.lane?.sessionKey ?? null)
      .filter((value): value is string => Boolean(value)),
  );
  const orderedBranchAgents = [...branchAgents]
    .filter((agent) => !packetBoundSessionKeys.has(agent.sessionKey) && !allPacketBoundSessionKeys.has(agent.sessionKey))
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

  // Status indicator — mirrors Superconductor's left-side glyph column:
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
          scheduleBranchHover(branch.name, target, event.clientX, event.clientY);
        }}
        onMouseLeave={(event) => {
          (event.currentTarget as HTMLDivElement).style.background = branchBaseBackground;
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
          transition: 'background 120ms ease',
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
            title={branch.name}
            style={{
              fontSize: 12,
              fontWeight: 440,
              color: 'var(--t-text)',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
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
          // vs the repo's default branch (what Superconductor shows).
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
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
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
      </div>
      )}

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
                const runtimeTone = orchestratorRuntimeTone(packet.runtime);
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
                      fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                      textAlign: 'left',
                      transition: 'background 120ms ease',
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
                      {packet.runtime === 'claude-code'
                        ? <ClaudeIcon size={13} />
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
                            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
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
                    return (
                      <button
                        key={agent.sessionKey}
                        type="button"
                        disabled={!onSelectSession}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelectSession?.(agent.sessionKey);
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
                          fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                          textAlign: 'left',
                          transition: 'background 120ms ease',
                        }}
                      >
                        <span style={{ width: 12, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginTop: 2 }}>
                          <AgentSpinner status={agent.status} size={6} />
                        </span>
                        {agent.runtime === 'claude-code'
                          ? <ClaudeIcon size={12} />
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
                            }}
                          >
                            {statusTone.label}
                          </span>
                        </div>
                      </button>
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
            padding: '14px 15px 13px',
            borderRadius: 18,
            border: '1px solid var(--t-panel-border)',
            background: 'linear-gradient(180deg, rgba(68, 75, 85, 0.96), rgba(54, 60, 69, 0.94))',
            backdropFilter: 'blur(28px) saturate(1.2)',
            WebkitBackdropFilter: 'blur(28px) saturate(1.2)',
            boxShadow: '0 22px 56px rgba(0, 0, 0, 0.28), 0 8px 24px rgba(15, 23, 42, 0.12)',
            color: 'var(--t-text)',
            ...resolveFloatingPanelPosition(branchHoverRect, 320),
          }}
        >
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: worktreeTone?.color ?? (branch.current ? THEME_SUCCESS_TEXT : THEME_ACCENT) }}>
            {branch.isWorktree ? (worktreeTone?.label ?? 'Worktree') : branch.current ? 'Current Branch' : 'Branch'}
          </div>
          <div style={{ marginTop: 6, fontSize: 15, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--t-text)' }}>
            {branch.name}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t-text-secondary)', background: 'var(--t-divider-subtle)', border: '1px solid var(--t-panel-border)', borderRadius: 999, padding: '3px 8px' }}>
              {branch.lastCommitAge}
            </span>
            {branchAgentLabel ? (
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t-text-secondary)', background: 'var(--t-divider-subtle)', border: '1px solid var(--t-panel-border)', borderRadius: 999, padding: '3px 8px' }}>
                {branchAgentLabel}
              </span>
            ) : null}
            {branchDiffAgent ? (
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t-text-secondary)', background: 'var(--t-divider-subtle)', border: '1px solid var(--t-panel-border)', borderRadius: 999, padding: '3px 8px', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                +{(branchDiffAgent.additions ?? 0).toLocaleString()} -{(branchDiffAgent.deletions ?? 0).toLocaleString()}
              </span>
            ) : null}
            {branch.ahead > 0 || branch.behind > 0 ? (
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t-text-secondary)', background: 'var(--t-divider-subtle)', border: '1px solid var(--t-panel-border)', borderRadius: 999, padding: '3px 8px', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                {branch.ahead > 0 ? `↑${branch.ahead}` : ''}{branch.behind > 0 ? ` ↓${branch.behind}` : ''}
              </span>
            ) : null}
            {branch.diskSize ? (
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t-text-secondary)', background: 'var(--t-divider-subtle)', border: '1px solid var(--t-panel-border)', borderRadius: 999, padding: '3px 8px', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                {branch.diskSize}
              </span>
            ) : null}
            {worktree ? (
              <span style={{ fontSize: 10, fontWeight: 700, color: worktreeTone?.color ?? THEME_WORKTREE_TEXT, background: worktreeTone?.background ?? THEME_WORKTREE_SOFT, border: `1px solid ${worktreeTone?.border ?? THEME_WORKTREE_BORDER}`, borderRadius: 999, padding: '3px 8px' }}>
                {worktree.status === 'stale' ? 'Needs cleanup' : 'Workspace tracked'}
              </span>
            ) : null}
          </div>
          {branchAgents.length > 0 ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
              {branchAgents.map((agent) => (
                <span
                  key={agent.sessionKey}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 10,
                    fontWeight: 700,
                    color: 'var(--t-text-secondary)',
                    background: 'var(--t-panel-hover)',
                    border: '1px solid var(--t-panel-border)',
                    borderRadius: 999,
                    padding: '4px 8px',
                  }}
                >
                  {agent.runtime === 'claude-code'
                    ? <ClaudeIcon size={12} color={agent.color} />
                    : <CodexIcon size={12} color={agent.color} />}
                  {agent.name}
                </span>
              ))}
            </div>
          ) : null}
          <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>
            {branch.lastCommitMessage || (branch.current ? 'Current branch checked out in this repository.' : 'Click the row to switch to this branch.')}
          </div>
          {worktree?.path ? (
            <div style={{ marginTop: 8, fontSize: 10, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace', lineHeight: 1.5 }}>
              {shortenPath(worktree.path)}
            </div>
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
                  onClick={() => window.open(`${githubUrl}/compare/${branch.name}?expand=1`, '_blank')}
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
    </div>
  );
}

export const RepoBranchRow = memo(RepoBranchRowBase);
