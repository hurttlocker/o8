'use client';

import { memo } from 'react';
import { CheckCircle2, FolderOpen, GitBranch, Globe, Loader2 } from '../lucide-shims';
import {
  AlertCircle,
  GlassModal,
  shortenPath,
  type RepoRegistryEntry,
  type ValidatedRepoCandidate,
  type WorkspaceCreateResult,
} from './shared';

// Normalise a remote URL to a friendly "owner/repo" label.
// https://github.com/hurttlocker/cortex-ide.git → hurttlocker/cortex-ide
// git@github.com:hurttlocker/cortex-ide.git     → hurttlocker/cortex-ide
function prettyRemoteLabel(remoteUrl: string): string {
  const trimmed = remoteUrl.trim().replace(/\.git$/, '');
  const sshMatch = trimmed.match(/git@([^:]+):(.+)$/);
  if (sshMatch) return sshMatch[2];
  try {
    const url = new URL(trimmed);
    return url.pathname.replace(/^\//, '');
  } catch {
    return trimmed;
  }
}

function Chip({
  icon,
  label,
  tone = 'neutral',
  muted = false,
}: {
  icon: React.ReactNode;
  label: string;
  tone?: 'neutral' | 'accent';
  muted?: boolean;
}) {
  const isAccent = tone === 'accent' && !muted;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 10px',
        borderRadius: 999,
        border: isAccent
          ? '1px solid rgba(143, 180, 255, 0.32)'
          : '1px solid var(--t-divider-strong)',
        background: isAccent
          ? 'rgba(143, 180, 255, 0.14)'
          : 'var(--t-divider-subtle)',
        color: muted
          ? 'var(--t-text-muted)'
          : isAccent
            ? 'var(--t-accent)'
            : 'var(--t-text-secondary)',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '-0.005em',
      }}
    >
      {icon}
      {label}
    </span>
  );
}

interface RepoRegistryModalsProps {
  addOpen: boolean;
  resetAddModal: () => void;
  validating: boolean;
  validationError: string | null;
  validationResult: ValidatedRepoCandidate | null;
  adding: boolean;
  handleBrowseForRepo: () => Promise<void>;
  handleAddRepo: () => Promise<void>;
  workspaceRepo: RepoRegistryEntry | null;
  closeWorkspaceModal: () => void;
  workspaceName: string;
  setWorkspaceName: React.Dispatch<React.SetStateAction<string>>;
  branchPreview: string;
  workspaceBaseBranch: string;
  setWorkspaceBaseBranch: React.Dispatch<React.SetStateAction<string>>;
  workspaceUseSetup: boolean;
  setWorkspaceUseSetup: React.Dispatch<React.SetStateAction<boolean>>;
  workspaceError: string | null;
  workspaceResult: WorkspaceCreateResult | null;
  workspaceLoading: boolean;
  handleCreateWorkspace: () => Promise<void>;
  launchRepo: RepoRegistryEntry | null;
  closeLaunchModal: () => void;
  launchRuntime: 'codex' | 'claude-code';
  setLaunchRuntime: React.Dispatch<React.SetStateAction<'codex' | 'claude-code'>>;
  launchTaskName: string;
  setLaunchTaskName: React.Dispatch<React.SetStateAction<string>>;
  launchPrompt: string;
  setLaunchPrompt: React.Dispatch<React.SetStateAction<string>>;
  launchError: string | null;
  launchLoading: boolean;
  handleLaunchAgent: () => Promise<void>;
  removeTarget: RepoRegistryEntry | null;
  setRemoveTarget: React.Dispatch<React.SetStateAction<RepoRegistryEntry | null>>;
  removeError: string | null;
  setRemoveError: React.Dispatch<React.SetStateAction<string | null>>;
  removeBusy: boolean;
  setRemoveBusy: React.Dispatch<React.SetStateAction<boolean>>;
  handleRemoveRepo: () => Promise<void>;
}

function RepoRegistryModalsBase({
  addOpen,
  resetAddModal,
  validating,
  validationError,
  validationResult,
  adding,
  handleBrowseForRepo,
  handleAddRepo,
  workspaceRepo,
  closeWorkspaceModal,
  workspaceName,
  setWorkspaceName,
  branchPreview,
  workspaceBaseBranch,
  setWorkspaceBaseBranch,
  workspaceUseSetup,
  setWorkspaceUseSetup,
  workspaceError,
  workspaceResult,
  workspaceLoading,
  handleCreateWorkspace,
  launchRepo,
  closeLaunchModal,
  launchRuntime,
  setLaunchRuntime,
  launchTaskName,
  setLaunchTaskName,
  launchPrompt,
  setLaunchPrompt,
  launchError,
  launchLoading,
  handleLaunchAgent,
  removeTarget,
  setRemoveTarget,
  removeError,
  setRemoveError,
  removeBusy,
  setRemoveBusy,
  handleRemoveRepo,
}: RepoRegistryModalsProps) {
  return (
    <>
      <GlassModal
        open={addOpen}
        onClose={resetAddModal}
        title="Add a Repository"
        subtitle="Pick a folder on your Mac. o8 will detect the branch and link your GitHub remote automatically."
      >
        {validationResult ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
              padding: 18,
              borderRadius: 14,
              border: '1px solid var(--t-panel-border)',
              background: 'var(--t-bg-card, rgba(148, 163, 184, 0.06))',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 12,
                  display: 'grid',
                  placeItems: 'center',
                  background: 'rgba(143, 180, 255, 0.14)',
                  color: '#8fb4ff',
                  flexShrink: 0,
                }}
              >
                <FolderOpen size={22} strokeWidth={1.8} />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontSize: 16,
                    fontWeight: 700,
                    color: 'var(--t-text)',
                    letterSpacing: '-0.01em',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {validationResult.name}
                </div>
                <div
                  style={{
                    marginTop: 2,
                    fontSize: 12,
                    color: 'var(--t-text-muted)',
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={shortenPath(validationResult.localPath)}
                >
                  {shortenPath(validationResult.localPath)}
                </div>
              </div>
              <div
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 12,
                  display: 'grid',
                  placeItems: 'center',
                  background: 'rgba(34, 197, 94, 0.14)',
                  color: '#16a34a',
                  flexShrink: 0,
                }}
                aria-label="Validated"
              >
                <CheckCircle2 size={14} strokeWidth={2.4} />
              </div>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <Chip icon={<GitBranch size={12} strokeWidth={2} />} label={validationResult.defaultBranch} />
              {validationResult.remoteUrl ? (
                <Chip
                  icon={<Globe size={12} strokeWidth={2} />}
                  label={prettyRemoteLabel(validationResult.remoteUrl)}
                  tone="accent"
                />
              ) : (
                <Chip icon={<Globe size={12} strokeWidth={2} />} label="No remote linked" muted />
              )}
            </div>

            <button
              type="button"
              onClick={() => { void handleBrowseForRepo(); }}
              disabled={validating || adding}
              style={{
                alignSelf: 'flex-start',
                padding: 0,
                border: 'none',
                background: 'transparent',
                color: 'var(--t-accent)',
                fontSize: 12,
                fontWeight: 600,
                cursor: validating || adding ? 'default' : 'pointer',
                opacity: validating || adding ? 0.45 : 1,
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              }}
            >
              Choose a different folder
            </button>
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 16,
              padding: '28px 20px',
              borderRadius: 14,
              border: '1px dashed var(--t-panel-border)',
              background: 'var(--t-bg-card, rgba(148, 163, 184, 0.04))',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: 18,
                display: 'grid',
                placeItems: 'center',
                background: 'rgba(143, 180, 255, 0.14)',
                color: '#8fb4ff',
              }}
            >
              <FolderOpen size={28} strokeWidth={1.6} />
            </div>
            <button
              type="button"
              onClick={() => { void handleBrowseForRepo(); }}
              disabled={validating || adding}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                minHeight: 42,
                padding: '0 22px',
                borderRadius: 12,
                border: '1px solid rgba(143, 180, 255, 0.36)',
                background: 'rgba(143, 180, 255, 0.18)',
                color: 'var(--t-accent)',
                fontSize: 13,
                fontWeight: 700,
                cursor: validating || adding ? 'not-allowed' : 'pointer',
                opacity: validating || adding ? 0.6 : 1,
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                boxShadow: validating ? 'none' : '0 0 12px rgba(143, 180, 255, 0.24)',
                letterSpacing: '-0.01em',
              }}
            >
              {validating ? (
                <>
                  <Loader2 size={14} strokeWidth={2.2} style={{ animation: 'spin 900ms linear infinite' }} />
                  Opening folder…
                </>
              ) : (
                <>
                  <FolderOpen size={14} strokeWidth={2} />
                  Choose Folder
                </>
              )}
            </button>
            <div
              style={{
                maxWidth: 360,
                fontSize: 12,
                lineHeight: 1.5,
                color: 'var(--t-text-muted)',
              }}
            >
              We&apos;ll scan it, find your GitHub remote, and add it to your fleet.
            </div>
          </div>
        )}

        {validationError ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid rgba(239, 68, 68, 0.2)',
              background: 'rgba(254, 226, 226, 0.24)',
              color: '#ef4444',
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            <AlertCircle size={14} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{validationError}</span>
          </div>
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10 }}>
          <button
            type="button"
            onClick={resetAddModal}
            disabled={adding}
            style={{
              minHeight: 36,
              padding: '8px 14px',
              borderRadius: 10,
              border: '1px solid var(--t-btn-secondary-border)',
              background: 'transparent',
              color: 'var(--t-text-secondary)',
              fontSize: 12,
              fontWeight: 600,
              cursor: adding ? 'not-allowed' : 'pointer',
              opacity: adding ? 0.45 : 1,
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { void handleAddRepo(); }}
            disabled={!validationResult || adding || validating}
            style={{
              minHeight: 36,
              padding: '8px 16px',
              borderRadius: 10,
              border: '1px solid rgba(143, 180, 255, 0.36)',
              background: !validationResult || adding || validating
                ? 'rgba(143, 180, 255, 0.1)'
                : 'rgba(143, 180, 255, 0.22)',
              color: 'var(--t-accent)',
              fontSize: 12,
              fontWeight: 700,
              cursor: !validationResult || adding || validating ? 'not-allowed' : 'pointer',
              opacity: !validationResult || adding || validating ? 0.55 : 1,
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              boxShadow: !validationResult || adding || validating ? 'none' : '0 0 10px rgba(143, 180, 255, 0.24)',
              letterSpacing: '-0.01em',
            }}
          >
            {adding ? 'Adding…' : 'Add Repository'}
          </button>
        </div>
      </GlassModal>

      <GlassModal
        open={workspaceRepo !== null}
        onClose={closeWorkspaceModal}
        title={workspaceRepo ? `New Workspace · ${workspaceRepo.name}` : 'New Workspace'}
        subtitle="This reuses the existing worktree API. Cortex derives a worktree branch from the name below and returns the new workspace path after creation."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label htmlFor="create-workspace-name" style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            Workspace name
          </label>
          <input
            id="create-workspace-name"
            name="createWorkspaceName"
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.currentTarget.value)}
            placeholder="repo-sync-20260317"
            style={{
              width: '100%',
              minHeight: 40,
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid var(--t-btn-secondary-border)',
              background: 'var(--t-input-bg)',
              color: 'var(--t-text)',
              fontSize: 13,
              fontFamily: '"SF Mono", ui-monospace, monospace',
              outline: 'none',
            }}
          />
          <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Branch preview</div>
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid var(--t-divider-subtle)',
              background: 'var(--t-input-bg)',
              color: 'var(--t-text)',
              fontSize: 12,
              fontFamily: '"SF Mono", ui-monospace, monospace',
              wordBreak: 'break-all',
            }}
          >
            {branchPreview}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label htmlFor="create-workspace-base-branch" style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            Base branch
          </label>
          <input
            id="create-workspace-base-branch"
            name="createWorkspaceBaseBranch"
            value={workspaceBaseBranch}
            onChange={(event) => setWorkspaceBaseBranch(event.currentTarget.value)}
            placeholder="main"
            style={{
              width: '100%',
              minHeight: 40,
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid var(--t-btn-secondary-border)',
              background: 'var(--t-input-bg)',
              color: 'var(--t-text)',
              fontSize: 13,
              fontFamily: '"SF Mono", ui-monospace, monospace',
              outline: 'none',
            }}
          />
        </div>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
          <input
            id="create-workspace-use-setup"
            name="createWorkspaceUseSetup"
            type="checkbox"
            checked={workspaceUseSetup}
            onChange={(event) => setWorkspaceUseSetup(event.currentTarget.checked)}
            style={{ marginTop: 2, accentColor: '#ef4444' }}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
              Run dependency setup
            </div>
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                color: 'var(--t-text-muted)',
                lineHeight: 1.45,
                fontFamily: '"SF Mono", ui-monospace, monospace',
              }}
            >
              {workspaceRepo?.setup.installCommand ?? 'No install command detected'}
            </div>
          </div>
        </label>

        {workspaceRepo?.setup.runBuildOnCreateWorkspace || workspaceRepo?.setup.envMode !== 'copy' ? (
          <div
            style={{
              padding: 12,
              borderRadius: 12,
              border: '1px solid rgba(37, 99, 235, 0.12)',
              background: 'rgba(239, 246, 255, 0.78)',
              fontSize: 11,
              lineHeight: 1.5,
              color: '#1d4ed8',
            }}
          >
            Saved repo setup includes env/build preferences. Env files now bootstrap into new workspaces automatically, and build preferences remain available for the next bootstrap pass.
          </div>
        ) : null}

        {workspaceError ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: 12,
              borderRadius: 12,
              border: '1px solid rgba(239, 68, 68, 0.18)',
              background: 'rgba(254, 242, 242, 0.82)',
              color: '#991b1b',
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            <AlertCircle size={14} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{workspaceError}</span>
          </div>
        ) : null}

        {workspaceResult ? (
          <div
            style={{
              padding: 12,
              borderRadius: 12,
              border: '1px solid rgba(34, 197, 94, 0.18)',
              background: 'rgba(240, 253, 244, 0.85)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                fontWeight: 700,
                color: '#166534',
              }}
            >
              <CheckCircle2 size={14} strokeWidth={2} />
              Workspace created
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '84px 1fr', gap: '6px 10px', fontSize: 12 }}>
              <span style={{ color: 'var(--t-text-muted)' }}>Branch</span>
              <span style={{ color: 'var(--t-text)', fontFamily: '"SF Mono", ui-monospace, monospace', wordBreak: 'break-all' }}>
                {workspaceResult.branch}
              </span>
              <span style={{ color: 'var(--t-text-muted)' }}>Location</span>
              <span style={{ color: 'var(--t-text)', fontFamily: '"SF Mono", ui-monospace, monospace', wordBreak: 'break-all' }}>
                {shortenPath(workspaceResult.path)}
              </span>
              <span style={{ color: 'var(--t-text-muted)' }}>Base</span>
              <span style={{ color: 'var(--t-text)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                {workspaceResult.baseBranch}
              </span>
            </div>
          </div>
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10 }}>
          <button
            type="button"
            onClick={closeWorkspaceModal}
            style={{
              minHeight: 36,
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid var(--t-btn-secondary-border)',
              background: 'var(--t-panel-hover)',
              color: 'var(--t-text-secondary)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            }}
          >
            {workspaceResult ? 'Close' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={() => {
              void handleCreateWorkspace();
            }}
            disabled={workspaceLoading}
            style={{
              minHeight: 36,
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid rgba(239, 68, 68, 0.2)',
              background: 'rgba(239, 68, 68, 0.08)',
              color: '#b91c1c',
              fontSize: 12,
              fontWeight: 700,
              cursor: workspaceLoading ? 'not-allowed' : 'pointer',
              opacity: workspaceLoading ? 0.45 : 1,
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            }}
          >
            {workspaceLoading ? 'Creating…' : workspaceResult ? 'Create Another' : 'Create Workspace'}
          </button>
        </div>
      </GlassModal>

      <GlassModal
        open={launchRepo !== null}
        onClose={closeLaunchModal}
        title={launchRepo ? `Launch Agent · ${launchRepo.name}` : 'Launch Agent'}
        subtitle="Open a new workspace CLI tab with the runtime you want. Add a prompt only if you want the agent to start immediately."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label htmlFor="launch-agent-runtime" style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            Runtime
          </label>
          <select
            id="launch-agent-runtime"
            name="launchAgentRuntime"
            value={launchRuntime}
            onChange={(event) => setLaunchRuntime(event.currentTarget.value as 'codex' | 'claude-code')}
            style={{
              width: '100%',
              minHeight: 40,
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid var(--t-btn-secondary-border)',
              background: 'var(--t-input-bg)',
              color: 'var(--t-text)',
              fontSize: 13,
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              outline: 'none',
            }}
          >
            <option value="codex">Codex</option>
            <option value="claude-code">Claude Code</option>
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label htmlFor="launch-agent-tab-label" style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            Tab label
          </label>
          <input
            id="launch-agent-tab-label"
            name="launchAgentTabLabel"
            value={launchTaskName}
            onChange={(event) => setLaunchTaskName(event.currentTarget.value)}
            placeholder="Optional"
            style={{
              width: '100%',
              minHeight: 40,
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid var(--t-btn-secondary-border)',
              background: 'var(--t-input-bg)',
              color: 'var(--t-text)',
              fontSize: 13,
              fontFamily: '"SF Mono", ui-monospace, monospace',
              outline: 'none',
            }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label htmlFor="launch-agent-prompt" style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            Initial prompt
          </label>
          <textarea
            id="launch-agent-prompt"
            name="launchAgentPrompt"
            value={launchPrompt}
            onChange={(event) => setLaunchPrompt(event.currentTarget.value)}
            rows={6}
            placeholder="Optional. Leave blank to open a ready session and steer it yourself."
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid var(--t-btn-secondary-border)',
              background: 'var(--t-input-bg)',
              color: 'var(--t-text)',
              fontSize: 13,
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              lineHeight: 1.5,
              outline: 'none',
              resize: 'vertical',
            }}
          />
        </div>

        <div
          style={{
            padding: 12,
            borderRadius: 12,
            border: '1px solid rgba(37, 99, 235, 0.12)',
            background: 'rgba(239, 246, 255, 0.78)',
            fontSize: 11,
            lineHeight: 1.5,
            color: '#1d4ed8',
          }}
        >
          This opens a new workspace CLI tab in the middle panel. Use the primary Launch Agent button for the fastest path, and use this sheet only when you want to choose the runtime or pre-seed the task prompt.
        </div>

        {launchError ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: 12,
              borderRadius: 12,
              border: '1px solid rgba(239, 68, 68, 0.18)',
              background: 'rgba(254, 242, 242, 0.82)',
              color: '#991b1b',
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            <AlertCircle size={14} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{launchError}</span>
          </div>
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10 }}>
          <button
            type="button"
            onClick={closeLaunchModal}
            style={{
              minHeight: 36,
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid var(--t-btn-secondary-border)',
              background: 'var(--t-panel-hover)',
              color: 'var(--t-text-secondary)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              void handleLaunchAgent();
            }}
            disabled={launchLoading}
            style={{
              minHeight: 36,
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid rgba(239, 68, 68, 0.2)',
              background: 'rgba(239, 68, 68, 0.08)',
              color: '#b91c1c',
              fontSize: 12,
              fontWeight: 700,
              cursor: launchLoading ? 'not-allowed' : 'pointer',
              opacity: launchLoading ? 0.45 : 1,
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            }}
          >
            {launchLoading ? 'Launching…' : 'Launch Agent'}
          </button>
        </div>
      </GlassModal>

      <GlassModal
        open={removeTarget !== null}
        onClose={() => {
          setRemoveTarget(null);
          setRemoveError(null);
          setRemoveBusy(false);
        }}
        title={removeTarget ? `Remove ${removeTarget.name}` : 'Remove Repository'}
        subtitle="This only removes the repo from Cortex's registry. It does not delete the local repository or any existing worktrees."
        width={460}
      >
        <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--t-text-muted)' }}>
          {removeTarget ? (
            <>
              <div style={{ color: 'var(--t-text)', fontWeight: 600 }}>{removeTarget.name}</div>
              <div style={{ marginTop: 6, fontFamily: '"SF Mono", ui-monospace, monospace', wordBreak: 'break-all' }}>
                {shortenPath(removeTarget.localPath)}
              </div>
            </>
          ) : null}
        </div>

        {removeError ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: 12,
              borderRadius: 12,
              border: '1px solid rgba(239, 68, 68, 0.18)',
              background: 'rgba(254, 242, 242, 0.82)',
              color: '#991b1b',
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            <AlertCircle size={14} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{removeError}</span>
          </div>
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10 }}>
          <button
            type="button"
            onClick={() => {
              setRemoveTarget(null);
              setRemoveError(null);
              setRemoveBusy(false);
            }}
            style={{
              minHeight: 36,
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid var(--t-btn-secondary-border)',
              background: 'var(--t-panel-hover)',
              color: 'var(--t-text-secondary)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              void handleRemoveRepo();
            }}
            disabled={removeBusy}
            style={{
              minHeight: 36,
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid rgba(239, 68, 68, 0.2)',
              background: 'rgba(239, 68, 68, 0.08)',
              color: '#b91c1c',
              fontSize: 12,
              fontWeight: 700,
              cursor: removeBusy ? 'not-allowed' : 'pointer',
              opacity: removeBusy ? 0.45 : 1,
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            }}
          >
            {removeBusy ? 'Removing…' : 'Remove Repository'}
          </button>
        </div>
      </GlassModal>
    </>
  );
}

export const RepoRegistryModals = memo(RepoRegistryModalsBase);
