'use client';

import { CheckCircle2 } from 'lucide-react';
import {
  AlertCircle,
  GlassModal,
  shortenPath,
  type RepoRegistryEntry,
  type ValidatedRepoCandidate,
  type WorkspaceCreateResult,
} from './shared';

interface RepoRegistryModalsProps {
  addOpen: boolean;
  resetAddModal: () => void;
  repoPathInput: string;
  setRepoPathInput: React.Dispatch<React.SetStateAction<string>>;
  validating: boolean;
  validationError: string | null;
  setValidationError: React.Dispatch<React.SetStateAction<string | null>>;
  validationResult: ValidatedRepoCandidate | null;
  setValidationResult: React.Dispatch<React.SetStateAction<ValidatedRepoCandidate | null>>;
  adding: boolean;
  handleBrowseForRepo: () => Promise<void>;
  handleValidate: () => Promise<void>;
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

export function RepoRegistryModals({
  addOpen,
  resetAddModal,
  repoPathInput,
  setRepoPathInput,
  validating,
  validationError,
  setValidationError,
  validationResult,
  setValidationResult,
  adding,
  handleBrowseForRepo,
  handleValidate,
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
        title="Add Repository"
        subtitle="First pass is local-folder only. Cortex validates the path, resolves the repo root, and records the default branch plus setup scaffold."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label htmlFor="add-repository-path" style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            Local folder path
          </label>
          <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
            <input
              id="add-repository-path"
              name="addRepositoryPath"
              value={repoPathInput}
              onChange={(event) => {
                setRepoPathInput(event.currentTarget.value);
                setValidationError(null);
                setValidationResult(null);
              }}
              placeholder="~/projects/cortex-ide"
              autoFocus
              style={{
                flex: 1,
                minHeight: 40,
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid var(--t-btn-secondary-border)',
                background: 'rgba(255, 255, 255, 0.55)',
                color: 'var(--t-text)',
                fontSize: 13,
                fontFamily: '"SF Mono", ui-monospace, monospace',
                outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={() => {
                void handleBrowseForRepo();
              }}
              disabled={validating || adding}
              style={{
                minHeight: 40,
                padding: '0 12px',
                borderRadius: 12,
                border: '1px solid var(--t-btn-secondary-border)',
                background: 'var(--t-panel-hover)',
                color: 'var(--t-text-secondary)',
                fontSize: 12,
                fontWeight: 600,
                cursor: validating || adding ? 'not-allowed' : 'pointer',
                opacity: validating || adding ? 0.45 : 1,
                fontFamily: '-apple-system, system-ui, sans-serif',
                whiteSpace: 'nowrap',
              }}
            >
              Browse…
            </button>
          </div>
        </div>

        {validationError ? (
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
            <span>{validationError}</span>
          </div>
        ) : null}

        {validationResult ? (
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
              Validation complete
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: '6px 10px', fontSize: 12 }}>
              <span style={{ color: 'var(--t-text-muted)' }}>Repo</span>
              <span style={{ color: 'var(--t-text)', fontWeight: 600 }}>{validationResult.name}</span>
              <span style={{ color: 'var(--t-text-muted)' }}>Path</span>
              <span style={{ color: 'var(--t-text)', fontFamily: '"SF Mono", ui-monospace, monospace', wordBreak: 'break-all' }}>
                {shortenPath(validationResult.localPath)}
              </span>
              <span style={{ color: 'var(--t-text-muted)' }}>Branch</span>
              <span style={{ color: 'var(--t-text)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                {validationResult.defaultBranch}
              </span>
              <span style={{ color: 'var(--t-text-muted)' }}>Remote</span>
              <span style={{ color: 'var(--t-text)', fontFamily: '"SF Mono", ui-monospace, monospace', wordBreak: 'break-all' }}>
                {validationResult.remoteUrl ?? 'No origin remote'}
              </span>
            </div>
          </div>
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10 }}>
          <button
            type="button"
            onClick={() => {
              void handleValidate();
            }}
            disabled={validating || adding}
            style={{
              minHeight: 36,
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid var(--t-btn-secondary-border)',
              background: 'var(--t-panel-hover)',
              color: 'var(--t-text-secondary)',
              fontSize: 12,
              fontWeight: 600,
              cursor: validating || adding ? 'not-allowed' : 'pointer',
              opacity: validating || adding ? 0.45 : 1,
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            {validating ? 'Validating…' : 'Validate'}
          </button>
          <button
            type="button"
            onClick={() => {
              void handleAddRepo();
            }}
            disabled={adding || validating}
            style={{
              minHeight: 36,
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid rgba(37, 99, 235, 0.2)',
              background: 'rgba(37, 99, 235, 0.08)',
              color: '#1d4ed8',
              fontSize: 12,
              fontWeight: 700,
              cursor: adding || validating ? 'not-allowed' : 'pointer',
              opacity: adding || validating ? 0.45 : 1,
              fontFamily: '-apple-system, system-ui, sans-serif',
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
              background: 'rgba(255, 255, 255, 0.55)',
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
              background: 'rgba(255, 255, 255, 0.45)',
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
              background: 'rgba(255, 255, 255, 0.55)',
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
              fontFamily: '-apple-system, system-ui, sans-serif',
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
              fontFamily: '-apple-system, system-ui, sans-serif',
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
              background: 'rgba(255, 255, 255, 0.55)',
              color: 'var(--t-text)',
              fontSize: 13,
              fontFamily: '-apple-system, system-ui, sans-serif',
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
              background: 'rgba(255, 255, 255, 0.55)',
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
              background: 'rgba(255, 255, 255, 0.55)',
              color: 'var(--t-text)',
              fontSize: 13,
              fontFamily: '-apple-system, system-ui, sans-serif',
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
              fontFamily: '-apple-system, system-ui, sans-serif',
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
              fontFamily: '-apple-system, system-ui, sans-serif',
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
              fontFamily: '-apple-system, system-ui, sans-serif',
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
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            {removeBusy ? 'Removing…' : 'Remove Repository'}
          </button>
        </div>
      </GlassModal>
    </>
  );
}
