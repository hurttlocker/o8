'use client';

import { memo } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, ExternalLink, PlayCircle } from 'lucide-react';
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

  return (
    <div>
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
          gap: 8,
          minHeight: branch.isWorktree ? 40 : 32,
          padding: '6px 7px',
          borderRadius: 8,
          background: branchBaseBackground,
          border: isActiveScope ? `1px solid ${THEME_ACCENT_BORDER}` : '1px solid transparent',
          cursor: branch.current ? 'default' : checkoutBusy ? 'wait' : 'pointer',
          transition: 'background 120ms ease, border-color 120ms ease',
        }}
      >
        <GitBranch
          size={11}
          strokeWidth={2}
          style={{
            flexShrink: 0,
            color: isActiveScope ? THEME_ACCENT : branch.current ? THEME_SUCCESS_TEXT : branch.isWorktree ? THEME_WORKTREE_TEXT : 'var(--t-text-muted)',
            marginTop: branch.isWorktree ? 2 : 1,
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: branch.isWorktree ? 1 : 0, flex: 1, minWidth: 0 }}>
          <span
            style={{
              fontSize: 11.5,
              fontWeight: branch.current || branch.isWorktree ? 620 : 560,
              color: 'var(--t-text)',
              fontFamily: '"SF Mono", ui-monospace, monospace',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {branch.name}
          </span>
          {branch.isWorktree ? (() => {
            const hasPacketSession = branchPackets.some((packet) => packet.lane?.sessionKey);
            const hasAgentSession = branchAgents.length > 0;
            const hasSession = hasPacketSession || hasAgentSession;
            const laneStatus = branchPackets.find((packet) => packet.lane?.lastEventLabel)?.lane?.lastEventLabel;
            const statusLabel = hasSession
              ? (laneStatus === 'agent_completed' ? 'Completed' : laneStatus === 'session_launched' ? 'Working' : 'Has session')
              : worktreeTone?.label ?? 'No session';
            const statusColor = hasSession ? '#15803d' : 'var(--t-text-faint)';
            return (
              <span
                style={{
                  fontSize: 10,
                  lineHeight: 1.2,
                  color: statusColor,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {statusLabel}
              </span>
            );
          })() : null}
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
        {branchDiffAgent ? (
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--t-text-secondary)',
              fontFamily: '"SF Mono", ui-monospace, monospace',
              letterSpacing: '-0.01em',
              flexShrink: 0,
            }}
          >
            +{(branchDiffAgent.additions ?? 0).toLocaleString()} -{(branchDiffAgent.deletions ?? 0).toLocaleString()}
          </span>
        ) : null}
      </div>

      {branchPackets.length > 0 || orderedBranchAgents.length > 0 ? (
        <div
          style={{
            marginLeft: 24,
            marginTop: 4,
            marginBottom: 7,
            paddingLeft: 12,
            borderLeft: '1px solid var(--t-divider-subtle)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {branchPackets.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  color: 'var(--t-text-faint)',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                }}
              >
                <span>Work</span>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: 18,
                    height: 18,
                    padding: '0 6px',
                    borderRadius: 999,
                    background: 'var(--t-divider-subtle)',
                    color: 'var(--t-text-secondary)',
                    fontSize: 10,
                    fontWeight: 700,
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                    textTransform: 'none',
                    letterSpacing: 'normal',
                  }}
                >
                  {branchPackets.length}
                </span>
              </div>
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
                      gap: 10,
                      padding: '8px 10px',
                      borderRadius: 12,
                      border: isSelectedPacket ? `1px solid ${THEME_ACCENT_BORDER}` : '1px solid var(--t-panel-border)',
                      background: isSelectedPacket ? THEME_ACCENT_SOFT : 'rgba(255, 255, 255, 0.56)',
                      color: 'var(--t-text)',
                      cursor: packet.lane?.sessionKey && onSelectSession ? 'pointer' : 'default',
                      fontFamily: '-apple-system, system-ui, sans-serif',
                      textAlign: 'left',
                      boxShadow: isSelectedPacket ? `0 0 0 1px ${THEME_ACCENT_RING}` : 'none',
                      transition: 'background 160ms ease, border-color 160ms ease, box-shadow 160ms ease',
                      opacity: packet.lane?.sessionKey && onSelectSession ? 1 : 0.82,
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: statusTone.dot,
                        boxShadow: `0 0 12px ${statusTone.dot}44`,
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            padding: '2px 6px',
                            borderRadius: 999,
                            background: 'var(--t-divider-subtle)',
                            color: 'var(--t-text-secondary)',
                            fontSize: 9,
                            fontWeight: 800,
                            letterSpacing: '0.04em',
                            textTransform: 'uppercase',
                            flexShrink: 0,
                          }}
                        >
                          {packet.referenceLabel}
                        </span>
                        <span
                          style={{
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            fontSize: 11.5,
                            fontWeight: 640,
                            color: 'var(--t-text)',
                          }}
                        >
                          {packet.title}
                        </span>
                      </span>
                      <span
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          marginTop: 2,
                          minWidth: 0,
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis',
                          fontSize: 10,
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
                    <span
                      title={runtimeTone.label}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 28,
                        height: 28,
                        borderRadius: 999,
                        background: runtimeTone.background,
                        border: `1px solid ${runtimeTone.border}`,
                        color: runtimeTone.color,
                        flexShrink: 0,
                      }}
                    >
                      {packet.runtime === 'claude-code'
                        ? <ClaudeIcon size={18} color={runtimeTone.color} />
                        : <CodexIcon size={18} color={runtimeTone.color} />}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {orderedBranchAgents.length > 0 ? (
            <>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setSessionDisclosureByBranch((current) => ({
                    ...current,
                    [branch.name]: !(current[branch.name] ?? true),
                  }));
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  width: '100%',
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--t-text-faint)',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                }}
              >
                {sessionsExpanded ? <ChevronDown size={12} strokeWidth={2.2} /> : <ChevronRight size={12} strokeWidth={2.2} />}
                <span>Sessions</span>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: 18,
                    height: 18,
                    padding: '0 6px',
                    borderRadius: 999,
                    background: 'var(--t-divider-subtle)',
                    color: 'var(--t-text-secondary)',
                    fontSize: 10,
                    fontWeight: 700,
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                    textTransform: 'none',
                    letterSpacing: 'normal',
                  }}
                >
                  {orderedBranchAgents.length}
                </span>
              </button>
              {sessionsExpanded ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
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
                          gap: 8,
                          padding: '5px 6px',
                          borderRadius: 8,
                          border: 'none',
                          background: isSelectedSession ? 'var(--t-accent-soft)' : 'transparent',
                          color: 'var(--t-text)',
                          cursor: onSelectSession ? 'pointer' : 'default',
                          fontFamily: '-apple-system, system-ui, sans-serif',
                          textAlign: 'left',
                          transition: 'background 120ms ease',
                          opacity: onSelectSession ? 1 : 0.78,
                        }}
                      >
                        <AgentSpinner status={agent.status} size={6} />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span
                            style={{
                              display: 'block',
                              fontSize: 11,
                              fontWeight: 600,
                              lineHeight: 1.35,
                              color: isSelectedSession ? 'var(--t-accent)' : 'var(--t-text)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {branchSessionLabel(agent)}
                          </span>
                          <span
                            style={{
                              display: 'block',
                              marginTop: 1,
                              fontSize: 9,
                              lineHeight: 1.3,
                              color: 'var(--t-text-faint)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {agent.runtime === 'claude-code' ? 'Claude Code' : 'Codex'}
                          </span>
                        </span>
                        <span
                          style={{
                            flexShrink: 0,
                            fontSize: 9,
                            fontWeight: 600,
                            color: statusTone.color,
                          }}
                        >
                          {statusTone.label}
                        </span>
                        <span
                          title={agent.runtime === 'claude-code' ? 'Claude Code' : 'Codex'}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                            color: agent.runtime === 'claude-code' ? '#8b5cf6' : '#10b981',
                          }}
                        >
                          {agent.runtime === 'claude-code'
                            ? <ClaudeIcon size={16} color="#8b5cf6" />
                            : <CodexIcon size={16} color="#10b981" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
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
