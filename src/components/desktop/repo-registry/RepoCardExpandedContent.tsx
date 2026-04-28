'use client';

import { memo, useMemo, useState } from 'react';
import { GitBranch } from '../lucide-shims';
import {
  FolderOpen,
  THEME_ACCENT,
  THEME_ACCENT_BORDER,
  THEME_ACCENT_SOFT,
  AgentSpinner,
  orchestratorRuntimeTone,
  orchestratorStatusTone,
  packetMatchesBranch,
  repoOwnsPath,
  resolveDisplayRuntime,
  type BranchAgent,
  type OrchestratorPacket,
  type RepoRegistryEntry,
  CodexIcon,
  ClaudeIcon,
  GeminiIcon,
  OpenCodeIcon,
} from './shared';
import { RepoBranchRow } from './RepoBranchRow';
import type { RepoCardModel } from './useRepoCardModel';

interface RepoCardExpandedContentProps {
  repo: RepoRegistryEntry;
  agentsByBranch?: Map<string, BranchAgent[]>;
  orchestratorPackets?: OrchestratorPacket[];
  activeSessionKey?: string | null;
  activeWorkspacePath?: string | null;
  activeWorkspaceTabKind?: 'terminal' | 'chat' | 'llm-chat' | 'canvas' | 'orchestrator' | null;
  onFocusOrchestratorTab?: () => void;
  onFocusAssistantTab?: () => void;
  onSelectSession?: (sessionKey: string) => void;
  model: Omit<RepoCardModel, 'cardRef'>;
}

function RepoCardExpandedContentBase({
  repo,
  agentsByBranch,
  orchestratorPackets = [],
  activeSessionKey = null,
  activeWorkspacePath = null,
  activeWorkspaceTabKind = null,
  onFocusOrchestratorTab,
  onFocusAssistantTab,
  onSelectSession,
  model,
}: RepoCardExpandedContentProps) {
  const {
    branches,
    branchesLoading,
    devServerRunning,
    devLogsOpen,
    devLogs,
    checkoutTarget,
    setCheckoutTarget,
    checkoutBusy,
    checkoutDirty,
    setCheckoutDirty,
    hoveredBranchName,
    branchHoverRect,
    sessionDisclosureByBranch,
    setSessionDisclosureByBranch,
    createBranchOpen,
    setCreateBranchOpen,
    newBranchName,
    setNewBranchName,
    newBranchWorktree,
    setNewBranchWorktree,
    newBranchCreating,
    newBranchError,
    setNewBranchError,
    branchDeleteConfirm,
    setBranchDeleteConfirm,
    githubUrl,
    worktreesByBranch,
    handleCheckout,
    handleCleanupWorktree,
    handleDeleteBranch,
    handleCreateBranch,
    scheduleBranchHover,
    holdBranchHover,
    closeBranchHover,
    handleOpenDesktopPath,
  } = model;
  const [showAllBranches, setShowAllBranches] = useState(false);

  const repoScopedPackets = useMemo(
    () => orchestratorPackets.filter((packet) => (
      !packet.archivedAt
      && packet.releaseState !== 'released'
      && repoOwnsPath(repo.localPath, packet.workspaceTargetPath ?? packet.lane?.repoPath)
    )),
    [orchestratorPackets, repo.localPath],
  );
  // Active-work-only visibility rule (#workspace-prune-v2):
  // Show current branch, anything an agent is on, anything a packet targets,
  // and worktrees with a commit in the last 24h that aren't flagged stale.
  // Everything else (idle worktrees, plain non-current branches) collapses
  // under the "+ N idle" disclosure below — the rail is not a branch picker.
  const visibleBranches = useMemo(
    () => {
      const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - ACTIVE_WINDOW_MS;
      return branches.filter((branch) => {
        if (branch.current) return true;
        const branchAgents = agentsByBranch?.get(branch.name) ?? [];
        const hasAgent = Boolean(branchAgents.length);
        if (hasAgent) return true;
        const isPacketTarget = repoScopedPackets.some((packet) => packet.branchTarget.trim() === branch.name);
        if (isPacketTarget) return true;
        if (branch.isWorktree && !branch.isStale && branch.lastCommitUnix > cutoff) return true;
        return false;
      });
    },
    [agentsByBranch, branches, repoScopedPackets],
  );
  const hiddenBranchCount = useMemo(
    () => branches.length - visibleBranches.length,
    [branches, visibleBranches],
  );
  const unmatchedRepoPackets = useMemo(
    () => repoScopedPackets.filter((packet) => !visibleBranches.some((branch) => (
      packetMatchesBranch(packet, repo, branch, agentsByBranch?.get(branch.name) ?? [])
    ))),
    [agentsByBranch, repo, repoScopedPackets, visibleBranches],
  );
  const allPacketBoundSessionKeys = useMemo(
    () => new Set(
      repoScopedPackets
        .map((packet) => packet.lane?.sessionKey ?? null)
        .filter((value): value is string => Boolean(value)),
    ),
    [repoScopedPackets],
  );

  return (
    <div style={{ padding: '6px 14px 12px 14px' }}>
      {devLogsOpen && devServerRunning ? (
        <div
          style={{
            margin: '4px 0',
            borderRadius: 8,
            border: '1px solid var(--t-panel-border)',
            background: '#0f172a',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '4px 8px',
              background: 'rgba(255,255,255,0.03)',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <span style={{ fontSize: 9, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Dev Server Output
            </span>
            <span style={{ fontSize: 9, color: '#475569' }}>
              {repo.setup.devCommand}
            </span>
          </div>
          <pre
            style={{
              margin: 0,
              padding: 8,
              fontSize: 10,
              fontFamily: '"SF Mono", ui-monospace, monospace',
              color: '#e2e8f0',
              lineHeight: 1.5,
              maxHeight: 140,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {devLogs || 'Waiting for output…'}
          </pre>
        </div>
      ) : null}

      {/* Workspace tabs — Orchestrator + Assistant entry rows. The shimmer
          only fires when (a) this repo is the focused workspace AND (b) the
          matching kind of tab is the active one. That keeps the left rail
          honest: click an agent tab, the agent row shimmers; click the
          Assistant tab, only the Assistant row shimmers here. */}
      {(() => {
        const isActiveRepo = activeWorkspacePath === repo.localPath
          || (activeWorkspacePath && activeWorkspacePath.startsWith(repo.localPath + '/'));
        const orchestratorActive = Boolean(isActiveRepo && activeWorkspaceTabKind === 'orchestrator');
        const assistantActive = Boolean(isActiveRepo && activeWorkspaceTabKind === 'llm-chat');
        const orchestratorStatus = orchestratorActive ? 'Focused' : isActiveRepo ? 'Available' : 'Idle';
        const orchestratorStatusColor = orchestratorActive ? '#22c55e' : 'var(--t-text-faint)';
        const assistantStatus = assistantActive ? 'Focused' : isActiveRepo ? 'Available' : 'Idle';
        const assistantStatusColor = assistantActive ? '#22c55e' : 'var(--t-text-faint)';
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginBottom: 4 }}>
            <button
              type="button"
              title={orchestratorActive ? 'Orchestrator tab is active' : 'Switch to the Orchestrator tab'}
              onClick={() => onFocusOrchestratorTab?.()}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                padding: '5px 8px',
                borderRadius: 7,
                background: orchestratorActive ? 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))' : 'transparent',
                borderWidth: 0,
                cursor: onFocusOrchestratorTab ? 'pointer' : 'default',
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                textAlign: 'left',
                transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
              }}
            >
              <span style={{ width: 12, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginTop: 2 }}>
                <AgentSpinner status={orchestratorActive ? 'running' : 'idle'} size={6} />
              </span>
              <ClaudeIcon size={12} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 440,
                    color: 'var(--t-text)',
                    letterSpacing: '-0.005em',
                    lineHeight: 1.35,
                    ...(orchestratorActive
                      ? { animation: 'tab-label-shimmer 2.2s ease-in-out infinite' }
                      : null),
                  }}
                >
                  Orchestrator
                </span>
                <span style={{ fontSize: 10, fontWeight: 400, color: orchestratorStatusColor, letterSpacing: '-0.005em', lineHeight: 1.3 }}>
                  {orchestratorStatus}
                </span>
              </div>
            </button>
            <button
              type="button"
              title={assistantActive ? 'Assistant tab is active' : 'Switch to the Assistant tab'}
              onClick={() => onFocusAssistantTab?.()}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                padding: '5px 8px',
                borderRadius: 7,
                background: assistantActive ? 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))' : 'transparent',
                borderWidth: 0,
                cursor: onFocusAssistantTab ? 'pointer' : 'default',
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                textAlign: 'left',
                transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
              }}
            >
              <span style={{ width: 12, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginTop: 2 }}>
                <AgentSpinner status={assistantActive ? 'running' : 'idle'} size={6} />
              </span>
              <ClaudeIcon size={12} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 440,
                    color: 'var(--t-text)',
                    letterSpacing: '-0.005em',
                    lineHeight: 1.35,
                    ...(assistantActive
                      ? { animation: 'tab-label-shimmer 2.2s ease-in-out infinite' }
                      : null),
                  }}
                >
                  Assistant
                </span>
                <span style={{ fontSize: 10, fontWeight: 400, color: assistantStatusColor, letterSpacing: '-0.005em', lineHeight: 1.3 }}>
                  {assistantStatus}
                </span>
              </div>
            </button>
          </div>
        );
      })()}

      {unmatchedRepoPackets.length > 0 ? (
        <div style={{ marginTop: 2, display: 'flex', flexDirection: 'column', gap: 0 }}>
          {unmatchedRepoPackets.map((packet) => {
            const displayRuntime = resolveDisplayRuntime(packet);
            const runtimeTone = orchestratorRuntimeTone(displayRuntime);
            const statusTone = orchestratorStatusTone(packet.status);
            const isActivePacket = Boolean(
              activeSessionKey
              && packet.lane?.sessionKey
              && packet.lane.sessionKey === activeSessionKey,
            );
            return (
              <div
                key={packet.id}
                onClick={() => {
                  if (!onSelectSession) return;
                  if (packet.lane?.sessionKey) {
                    onSelectSession(packet.lane.sessionKey);
                    return;
                  }
                  void fetch('/api/lanes?active=true')
                    .then((response) => response.json())
                    .then((data: { lanes?: Array<{ packetId?: string; sessionKey?: string }> }) => {
                      const lane = data.lanes?.find((entry) => entry.packetId === packet.id && entry.sessionKey);
                      if (lane?.sessionKey) onSelectSession(lane.sessionKey);
                    })
                    .catch(() => {});
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 14px',
                  borderBottom: '1px solid var(--t-divider-subtle)',
                  cursor: onSelectSession ? 'pointer' : 'default',
                }}
              >
                <GitBranch
                  size={13}
                  strokeWidth={2}
                  style={{
                    flexShrink: 0,
                    color: statusTone.dot,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--t-text)',
                      letterSpacing: '-0.01em',
                      ...(isActivePacket
                        ? { animation: 'tab-label-shimmer 2.2s ease-in-out infinite' }
                        : null),
                    }}
                  >
                    {packet.title}
                  </span>
                  {packet.branchTarget ? (
                    <span
                      title={packet.branchTarget}
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: 10,
                        fontWeight: 440,
                        color: 'var(--t-text-muted)',
                        letterSpacing: '-0.005em',
                        fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
                      }}
                    >
                      {packet.branchTarget}
                    </span>
                  ) : null}
                </div>
                <span
                  title={runtimeTone.label}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    color: runtimeTone.color,
                  }}
                >
                  {displayRuntime === 'claude-code' ? <ClaudeIcon size={18} color={runtimeTone.color} />
                    : displayRuntime === 'gemini' ? <GeminiIcon size={18} />
                    : displayRuntime === 'opencode' ? <OpenCodeIcon size={18} />
                    : <CodexIcon size={18} color={runtimeTone.color} />}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      <div style={{ marginTop: 0 }}>
        {branchesLoading ? (
          <div
            style={{
              fontSize: 11.5,
              fontWeight: 440,
              color: 'var(--t-text-faint)',
              paddingTop: 6,
              paddingRight: 8,
              paddingBottom: 6,
              paddingLeft: 42,
              letterSpacing: '-0.005em',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            }}
          >
            Loading branches...
          </div>
        ) : visibleBranches.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {visibleBranches.map((branch) => (
              <RepoBranchRow
                key={branch.name}
                repo={repo}
                branch={branch}
                branchAgents={agentsByBranch?.get(branch.name) ?? []}
                orchestratorPackets={orchestratorPackets}
                allPacketBoundSessionKeys={allPacketBoundSessionKeys}
                sessionDisclosureByBranch={sessionDisclosureByBranch}
                setSessionDisclosureByBranch={setSessionDisclosureByBranch}
                worktree={worktreesByBranch.get(branch.name)}
                activeSessionKey={activeSessionKey}
                activeWorkspacePath={activeWorkspacePath}
                githubUrl={githubUrl}
                checkoutBusy={checkoutBusy}
                handleCheckout={handleCheckout}
                scheduleBranchHover={scheduleBranchHover}
                holdBranchHover={holdBranchHover}
                closeBranchHover={closeBranchHover}
                hoveredBranchName={hoveredBranchName}
                branchHoverRect={branchHoverRect}
                onSelectSession={onSelectSession}
                handleOpenDesktopPath={handleOpenDesktopPath}
                handleCleanupWorktree={handleCleanupWorktree}
                handleDeleteBranch={handleDeleteBranch}
                branchDeleteConfirm={branchDeleteConfirm}
                setBranchDeleteConfirm={setBranchDeleteConfirm}
              />
            ))}
          </div>
        ) : null}
      </div>

      {createBranchOpen ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: '10px',
            marginTop: 6,
            borderRadius: 12,
            background: 'var(--t-divider-subtle)',
            border: '1px solid var(--t-panel-border)',
          }}
        >
          <input
            id={`create-branch-name-${repo.id}`}
            name={`create-branch-name-${repo.id}`}
            value={newBranchName}
            onChange={(event) => setNewBranchName(event.currentTarget.value)}
            placeholder="feat/my-feature"
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void handleCreateBranch();
              }
              if (event.key === 'Escape') {
                setCreateBranchOpen(false);
                setNewBranchName('');
              }
            }}
            style={{
              width: '100%',
              minHeight: 42,
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid var(--t-input-border)',
              background: 'var(--t-input-bg)',
              fontSize: 12,
              fontFamily: '"SF Mono", ui-monospace, monospace',
              outline: 'none',
              color: 'var(--t-text)',
            }}
          />
          <div style={{ fontSize: 10, lineHeight: 1.45, color: 'var(--t-text-muted)' }}>
            {newBranchWorktree
              ? `Create an isolated worktree from ${repo.defaultBranch}.`
              : `Create a branch from ${repo.defaultBranch}.`}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 10, color: 'var(--t-text-secondary)' }}>
              <input
                id={`create-branch-worktree-${repo.id}`}
                name={`create-branch-worktree-${repo.id}`}
                type="checkbox"
                checked={newBranchWorktree}
                onChange={(event) => setNewBranchWorktree(event.currentTarget.checked)}
                style={{ accentColor: '#f59e0b' }}
              />
              Create worktree
            </label>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => {
                setCreateBranchOpen(false);
                setNewBranchName('');
                setNewBranchError(null);
              }}
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--t-text-secondary)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '4px 6px',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                void handleCreateBranch();
              }}
              disabled={newBranchCreating || !newBranchName.trim()}
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: THEME_ACCENT,
                background: THEME_ACCENT_SOFT,
                border: `1px solid ${THEME_ACCENT_BORDER}`,
                borderRadius: 999,
                padding: '6px 10px',
                cursor: newBranchCreating || !newBranchName.trim() ? 'not-allowed' : 'pointer',
                opacity: newBranchCreating || !newBranchName.trim() ? 0.5 : 1,
              }}
            >
              {newBranchCreating ? 'Creating…' : 'Create'}
            </button>
          </div>
          {newBranchError ? (
            <div style={{ fontSize: 10, color: '#dc2626' }}>{newBranchError}</div>
          ) : null}
        </div>
      ) : (
        <>
          {hiddenBranchCount > 0 && !showAllBranches && visibleBranches.length > 0 ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setShowAllBranches(true);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                padding: '6px 7px',
                marginTop: 2,
                border: 'none',
                background: 'transparent',
                color: 'var(--t-text-tertiary)',
                fontSize: 10.5,
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                borderRadius: 8,
                transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1)',
              }}
              onMouseEnter={(event) => {
                const target = event.currentTarget as HTMLButtonElement;
                target.style.color = 'var(--t-text-muted)';
                target.style.background = 'var(--t-panel-hover)';
              }}
              onMouseLeave={(event) => {
                const target = event.currentTarget as HTMLButtonElement;
                target.style.color = 'var(--t-text-tertiary)';
                target.style.background = 'transparent';
              }}
            >
              + {hiddenBranchCount} idle
            </button>
          ) : null}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setCreateBranchOpen(true);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              width: '100%',
              // paddingLeft matches the branch row's effective indent:
              // 8px row padding + 12px indicator slot + 9px flex gap = 29px
              // so the FolderOpen icon aligns with the GitBranch icons above.
              paddingTop: 6,
              paddingRight: 7,
              paddingBottom: 6,
              paddingLeft: 29,
              marginTop: 2,
              border: 'none',
              background: 'transparent',
              color: 'var(--t-text-muted)',
              fontSize: 11,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              borderRadius: 8,
              transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
            onMouseEnter={(event) => {
              const target = event.currentTarget as HTMLButtonElement;
              target.style.color = 'var(--t-text)';
              target.style.background = 'var(--t-panel-hover)';
            }}
            onMouseLeave={(event) => {
              const target = event.currentTarget as HTMLButtonElement;
              target.style.color = 'var(--t-text-muted)';
              target.style.background = 'transparent';
            }}
          >
            <FolderOpen size={11} strokeWidth={2} />
            New branch
          </button>
        </>
      )}

      {checkoutDirty && checkoutTarget ? (
        <div
          style={{
            margin: '6px 0',
            padding: 10,
            borderRadius: 10,
            background: 'rgba(245,158,11,0.04)',
            border: '1px solid rgba(245,158,11,0.12)',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, color: '#b45309', marginBottom: 6 }}>
            {checkoutDirty.fileCount} uncommitted change{checkoutDirty.fileCount === 1 ? '' : 's'}
          </div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--t-text-secondary)',
              fontFamily: '"SF Mono", ui-monospace, monospace',
              marginBottom: 8,
              maxHeight: 60,
              overflow: 'auto',
              lineHeight: 1.5,
            }}
          >
            {checkoutDirty.files.map((file, index) => (
              <div key={index}>{file}</div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              onClick={() => {
                void handleCheckout(checkoutTarget, { stash: true });
              }}
              disabled={checkoutBusy}
              style={{
                padding: '4px 10px',
                borderRadius: 6,
                border: '1px solid rgba(37,99,235,0.15)',
                background: 'rgba(37,99,235,0.06)',
                color: '#2563eb',
                fontSize: 10,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              }}
            >
              Stash & switch
            </button>
            <button
              type="button"
              onClick={() => {
                void handleCheckout(checkoutTarget, { force: true });
              }}
              disabled={checkoutBusy}
              style={{
                padding: '4px 10px',
                borderRadius: 6,
                border: '1px solid rgba(239,68,68,0.15)',
                background: 'rgba(239,68,68,0.04)',
                color: '#dc2626',
                fontSize: 10,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              }}
            >
              Force
            </button>
            <button
              type="button"
              onClick={() => {
                setCheckoutTarget(null);
                setCheckoutDirty(null);
              }}
              style={{
                padding: '4px 10px',
                borderRadius: 6,
                border: '1px solid var(--t-btn-secondary-border)',
                background: 'transparent',
                color: 'var(--t-text-secondary)',
                fontSize: 10,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export const RepoCardExpandedContent = memo(RepoCardExpandedContentBase);
