'use client';

import { memo } from 'react';
import { AlertCircle, SetupModeButton, type RepoRegistryEntry } from './shared';
import type { RepoCardModel } from './useRepoCardModel';

interface RepoCardSettingsProps {
  repo: RepoRegistryEntry;
  model: Omit<RepoCardModel, 'cardRef'>;
}

function RepoCardSettingsBase({ repo, model }: RepoCardSettingsProps) {
  const {
    settingsOpen,
    draftSetup,
    setDraftSetup,
    saveError,
    setSaveError,
    saving,
    hasUnsavedChanges,
    handleSave,
    updateEnvMode,
  } = model;

  if (!settingsOpen) {
    return null;
  }

  return (
    <div
      style={{
        borderTop: '1px solid var(--t-divider-subtle)',
        padding: '12px 14px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--t-text)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          Setup Profile
        </div>
        <div
          style={{
            marginTop: 4,
            fontSize: 11,
            lineHeight: 1.45,
            color: 'var(--t-text-muted)',
          }}
        >
          Environment handling and optional bootstrap commands are stored per repo here. Build and env hooks are scaffolded and not yet injected into workspace bootstrap.
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
          Environment files
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <SetupModeButton label="Copy" selected={draftSetup.envMode === 'copy'} onClick={() => updateEnvMode('copy')} />
          <SetupModeButton label="Symlink" selected={draftSetup.envMode === 'symlink'} onClick={() => updateEnvMode('symlink')} />
          <SetupModeButton label="Skip" selected={draftSetup.envMode === 'skip'} onClick={() => updateEnvMode('skip')} />
        </div>
        <input
          id={`repo-setup-env-files-${repo.id}`}
          name={`repo-setup-env-files-${repo.id}`}
          value={draftSetup.envFiles.join(', ')}
          onChange={(event) => {
            const envFiles = event.currentTarget.value.split(',');
            setDraftSetup((current) => ({
              ...current,
              envFiles,
            }));
          }}
          placeholder=".env, .env.local"
          style={{
            width: '100%',
            minHeight: 36,
            padding: '9px 11px',
            borderRadius: 10,
            border: '1px solid var(--t-btn-secondary-border)',
            background: 'var(--t-input-bg)',
            color: 'var(--t-text)',
            fontSize: 12,
            fontFamily: '"SF Mono", ui-monospace, monospace',
            outline: 'none',
          }}
        />
      </div>

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
        <input
          id={`repo-setup-install-${repo.id}`}
          name={`repo-setup-install-${repo.id}`}
          type="checkbox"
          checked={draftSetup.installOnCreateWorkspace}
          onChange={(event) => {
            const checked = event.currentTarget.checked;
            setDraftSetup((current) => ({
              ...current,
              installOnCreateWorkspace: checked,
            }));
          }}
          style={{ marginTop: 2, accentColor: '#ef4444' }}
        />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            Install dependencies on workspace create
          </div>
          <div
            style={{
              marginTop: 4,
              fontSize: 11,
              color: 'var(--t-text-muted)',
              fontFamily: '"SF Mono", ui-monospace, monospace',
              lineHeight: 1.45,
            }}
          >
            {draftSetup.installCommand ?? 'No install command detected'}
          </div>
        </div>
      </label>

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
        <input
          id={`repo-setup-build-${repo.id}`}
          name={`repo-setup-build-${repo.id}`}
          type="checkbox"
          checked={draftSetup.runBuildOnCreateWorkspace}
          onChange={(event) => {
            const checked = event.currentTarget.checked;
            setDraftSetup((current) => ({
              ...current,
              runBuildOnCreateWorkspace: checked,
            }));
          }}
          style={{ marginTop: 2, accentColor: '#ef4444' }}
        />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            Run build after setup
          </div>
          <div
            style={{
              marginTop: 4,
              fontSize: 11,
              color: 'var(--t-text-muted)',
              fontFamily: '"SF Mono", ui-monospace, monospace',
              lineHeight: 1.45,
            }}
          >
            {draftSetup.buildCommand ?? 'No build command detected'}
          </div>
        </div>
      </label>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
          Dev command
        </div>
        <input
          id={`repo-setup-dev-command-${repo.id}`}
          name={`repo-setup-dev-command-${repo.id}`}
          value={draftSetup.devCommand ?? ''}
          onChange={(event) => setDraftSetup((current) => ({ ...current, devCommand: event.currentTarget.value || null }))}
          placeholder="npm run dev"
          style={{
            width: '100%',
            padding: '6px 8px',
            borderRadius: 6,
            border: '1px solid var(--t-btn-secondary-border)',
            background: 'rgba(255,255,255,0.55)',
            fontSize: 11,
            fontFamily: '"SF Mono", ui-monospace, monospace',
            outline: 'none',
            color: 'var(--t-text)',
          }}
        />
        <div style={{ fontSize: 10, color: 'var(--t-text-faint)' }}>
          Starts the development server from the repo card.
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
          Default port
        </div>
        <input
          id={`repo-setup-default-port-${repo.id}`}
          name={`repo-setup-default-port-${repo.id}`}
          value={draftSetup.defaultPort ?? ''}
          onChange={(event) => {
            const value = event.currentTarget.value.trim();
            setDraftSetup((current) => ({ ...current, defaultPort: value ? parseInt(value, 10) || null : null }));
          }}
          placeholder="Auto-detect"
          type="number"
          style={{
            width: 100,
            padding: '6px 8px',
            borderRadius: 6,
            border: '1px solid var(--t-btn-secondary-border)',
            background: 'rgba(255,255,255,0.55)',
            fontSize: 11,
            fontFamily: '"SF Mono", ui-monospace, monospace',
            outline: 'none',
            color: 'var(--t-text)',
          }}
        />
        <div style={{ fontSize: 10, color: 'var(--t-text-faint)' }}>
          Port for the preview pane. Leave blank to auto-detect from output.
        </div>
      </div>

      {saveError ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 11,
            color: '#b91c1c',
          }}
        >
          <AlertCircle size={13} strokeWidth={2} />
          {saveError}
        </div>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={() => {
            void handleSave();
          }}
          disabled={saving || !hasUnsavedChanges}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            minHeight: 34,
            padding: '8px 12px',
            borderRadius: 10,
            border: '1px solid rgba(239, 68, 68, 0.2)',
            background: 'rgba(239, 68, 68, 0.08)',
            color: '#b91c1c',
            fontSize: 11,
            fontWeight: 700,
            cursor: saving || !hasUnsavedChanges ? 'not-allowed' : 'pointer',
            opacity: saving || !hasUnsavedChanges ? 0.45 : 1,
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
          }}
        >
          {saving ? 'Saving…' : 'Save Profile'}
        </button>
        <button
          type="button"
          onClick={() => {
            setDraftSetup(repo.setup);
            setSaveError(null);
          }}
          disabled={!hasUnsavedChanges || saving}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 34,
            padding: '8px 12px',
            borderRadius: 10,
            border: '1px solid var(--t-btn-secondary-border)',
            background: 'var(--t-panel-hover)',
            color: 'var(--t-text-secondary)',
            fontSize: 11,
            fontWeight: 600,
            cursor: !hasUnsavedChanges || saving ? 'not-allowed' : 'pointer',
            opacity: !hasUnsavedChanges || saving ? 0.45 : 1,
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
          }}
        >
          Reset
        </button>
      </div>
    </div>
  );
}

export const RepoCardSettings = memo(RepoCardSettingsBase);
