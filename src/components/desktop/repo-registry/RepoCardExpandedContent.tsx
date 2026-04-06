'use client';

import { memo, useMemo, useState } from 'react';
import { GitBranch } from 'lucide-react';
import {
  FolderOpen,
  THEME_ACCENT,
  THEME_ACCENT_BORDER,
  THEME_ACCENT_SOFT,
  orchestratorRuntimeTone,
  orchestratorStatusTone,
  packetMatchesBranch,
  repoOwnsPath,
  type BranchAgent,
  type OrchestratorPacket,
  type RepoRegistryEntry,
  CodexIcon,
  ClaudeIcon,
} from './shared';
import { RepoBranchRow } from './RepoBranchRow';
import type { RepoCardModel } from './useRepoCardModel';

interface RepoCardExpandedContentProps {
  repo: RepoRegistryEntry;
  agentsByBranch?: Map<string, BranchAgent[]>;
  orchestratorPackets?: OrchestratorPacket[];
  activeSessionKey?: string | null;
  activeWorkspacePath?: string | null;
  onSelectSession?: (sessionKey: string) => void;
  model: Omit<RepoCardModel, 'cardRef'>;
}

function RepoCardExpandedContentBase({
  repo,
  agentsByBranch,
  orchestratorPackets = [],
  activeSessionKey = null,
  activeWorkspacePath = null,
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
  const visibleBranches = useMemo(
    () => branches.filter((branch) => {
      const branchAgents = agentsByBranch?.get(branch.name) ?? [];
      const hasAgent = Boolean(branchAgents.length);
      const isPacketTarget = repoScopedPackets.some((packet) => packet.branchTarget.trim() === branch.name);
      return (
        branch.isWorktree
        || !branch.current
        || hasAgent
        || isPacketTarget
        || (branch.current && repoScopedPackets.some((packet) => packet.branchTarget.trim() === '' || packet.branchTarget.trim() === branch.name))
      );
    }),
    [agentsByBranch, branches, repoScopedPackets],
  );
  const hiddenBranchCount = useMemo(
    () => branches.filter((branch) => branch.isWorktree && !visibleBranches.some((visibleBranch) => visibleBranch.name === branch.name)).length,
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
    <div style={{ padding: '4px 14px 14px 14px' }}>
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

      {unmatchedRepoPackets.length > 0 ? (
        <div style={{ marginTop: 2, display: 'flex', flexDirection: 'column', gap: 0 }}>
          {unmatchedRepoPackets.map((packet) => {
            const runtimeTone = orchestratorRuntimeTone(packet.runtime);
            const statusTone = orchestratorStatusTone(packet.status);
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
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--t-text)',
                    letterSpacing: '-0.01em',
                  }}
                >
                  {packet.title}
                </span>
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
                  {packet.runtime === 'claude-code'
                    ? <ClaudeIcon size={18} color={runtimeTone.color} />
                    : <CodexIcon size={18} color={runtimeTone.color} />}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      <div style={{ marginTop: 6 }}>
        {branchesLoading ? (
          <div style={{ fontSize: 11, color: 'var(--t-text-faint)', padding: '4px 0' }}>Loading branches…</div>
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
                fontFamily: '-apple-system, system-ui, sans-serif',
                borderRadius: 8,
                transition: 'background 140ms ease, color 140ms ease',
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
              + {hiddenBranchCount} worktree{hiddenBranchCount !== 1 ? 's' : ''}
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
              padding: '6px 7px',
              marginTop: 2,
              border: 'none',
              background: 'transparent',
              color: 'var(--t-text-muted)',
              fontSize: 11,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: '-apple-system, system-ui, sans-serif',
              borderRadius: 8,
              transition: 'background 140ms ease, color 140ms ease',
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
                fontFamily: '-apple-system, system-ui, sans-serif',
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
                fontFamily: '-apple-system, system-ui, sans-serif',
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
                fontFamily: '-apple-system, system-ui, sans-serif',
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
