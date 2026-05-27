'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ProjectRole } from '@/lib/projects/types';
import { AlertCircle, CheckCircle2, FolderOpen, GitBranch, Globe, Loader2 } from '../lucide-shims';
import {
  GlassModal,
  requestJson,
  shortenPath,
  type RepoRegistryEntry,
  type ValidatedRepoCandidate,
} from './shared';
import type { ProjectRecord } from './useProjects';

const ROLE_OPTIONS: Array<{ value: ProjectRole; label: string }> = [
  { value: 'fullstack', label: 'Fullstack' },
  { value: 'frontend', label: 'Frontend' },
  { value: 'backend', label: 'Backend' },
  { value: 'mobile', label: 'Mobile' },
  { value: 'site', label: 'Site' },
  { value: 'service', label: 'Service' },
  { value: 'library', label: 'Library' },
  { value: 'infra', label: 'Infra' },
  { value: 'docs', label: 'Docs' },
  { value: 'shared', label: 'Shared' },
];

interface StoredProject {
  id: string;
  name: string;
  slug?: string | null;
}

function prettyRemoteLabel(remoteUrl: string): string {
  const trimmed = remoteUrl.trim().replace(/\.git$/, '');
  const sshMatch = trimmed.match(/git@([^:]+):(.+)$/);
  if (sshMatch) return sshMatch[2] ?? trimmed;
  try {
    const url = new URL(trimmed);
    return url.pathname.replace(/^\//, '');
  } catch {
    return trimmed;
  }
}

function inferRepoRole(repo: ValidatedRepoCandidate): ProjectRole {
  const haystack = [
    repo.name,
    repo.localPath,
    repo.remoteUrl ?? '',
  ].join(' ').toLowerCase();

  if (/\b(mobile|ios|android|expo|react-native|rn)\b/.test(haystack)) return 'mobile';
  if (/\b(site|web|landing|marketing|next)\b/.test(haystack)) return 'site';
  if (/\b(api|server|service|worker|backend)\b/.test(haystack)) return 'service';
  if (/\b(docs|documentation|handbook)\b/.test(haystack)) return 'docs';
  if (/\b(infra|deploy|ops|terraform)\b/.test(haystack)) return 'infra';
  if (/\b(lib|library|sdk|package)\b/.test(haystack)) return 'library';
  return 'fullstack';
}

async function pickFolderPath() {
  let folderPath: string | null = null;

  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({ directory: true, title: 'Select repository folder' });
    if (typeof result === 'string') folderPath = result;
  } catch {
    try {
      const response = await fetch('/api/panel/browse-folder', { method: 'POST' });
      const data = await response.json() as { path?: string | null };
      if (typeof data.path === 'string') folderPath = data.path;
    } catch {
      folderPath = window.prompt('Enter repository folder path:');
    }
  }

  const trimmed = folderPath?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function fieldStyle(): CSSProperties {
  return {
    width: '100%',
    minHeight: 34,
    borderRadius: 9,
    border: '1px solid var(--t-btn-secondary-border)',
    background: 'var(--t-input-bg)',
    color: 'var(--t-text)',
    fontFamily: 'var(--font-sans-system)',
    fontSize: 12,
    lineHeight: '16px',
    fontWeight: 450,
    outline: 'none',
  };
}

function smallButtonStyle(disabled = false): CSSProperties {
  return {
    minHeight: 34,
    borderRadius: 9,
    border: '1px solid var(--t-btn-secondary-border)',
    background: 'var(--t-hover)',
    color: disabled ? 'var(--t-text-faint)' : 'var(--t-text)',
    cursor: disabled ? 'default' : 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingTop: 7,
    paddingRight: 10,
    paddingBottom: 7,
    paddingLeft: 10,
    fontFamily: 'var(--font-sans-system)',
    fontSize: 11.5,
    lineHeight: '15px',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    opacity: disabled ? 0.58 : 1,
  };
}

function primaryButtonStyle(disabled = false): CSSProperties {
  return {
    minHeight: 36,
    paddingTop: 8,
    paddingRight: 15,
    paddingBottom: 8,
    paddingLeft: 15,
    borderRadius: 10,
    border: '1px solid color-mix(in srgb, var(--t-accent) 26%, transparent)',
    background: disabled
      ? 'color-mix(in srgb, var(--t-accent-soft) 52%, transparent)'
      : 'var(--t-accent-soft)',
    color: 'var(--t-accent)',
    fontSize: 12,
    lineHeight: '16px',
    fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
    fontFamily: 'var(--font-sans-system)',
    letterSpacing: 0,
  };
}

export function AddRepoDialog({
  open,
  projects,
  activeProjectId,
  onClose,
  onRepoAdded,
  onProjectsChanged,
  initialMode,
}: {
  open: boolean;
  projects: ProjectRecord[];
  activeProjectId: string | null;
  onClose: () => void;
  onRepoAdded?: (repo: RepoRegistryEntry) => void | Promise<void>;
  onProjectsChanged?: () => void | Promise<void>;
  // Hint passed by the empty-state Project chip's submenu:
  //   - 'existing' → auto-open the system folder picker on dialog mount
  //   - 'scratch'  → focus the path input with a "new folder" hint
  // Both flows still funnel through the same validate → register path.
  initialMode?: 'scratch' | 'existing';
}) {
  const [repoPathInput, setRepoPathInput] = useState('');
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validationResult, setValidationResult] = useState<ValidatedRepoCandidate | null>(null);
  const [adding, setAdding] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState<ProjectRole>('fullstack');

  const visibleProjects = useMemo(() => {
    const hasConcreteProject = projects.some((project) => project.id !== 'default');
    return hasConcreteProject ? projects.filter((project) => project.id !== 'default') : projects;
  }, [projects]);

  const defaultProjectId = useMemo(() => {
    const active = visibleProjects.find((project) => project.id === activeProjectId);
    return active?.id ?? visibleProjects[0]?.id ?? 'none';
  }, [activeProjectId, visibleProjects]);

  const effectiveProjectId = selectedProjectId ?? defaultProjectId;
  const selectedProject = effectiveProjectId === 'none'
    ? null
    : visibleProjects.find((project) => project.id === effectiveProjectId) ?? null;

  const reset = useCallback(() => {
    setRepoPathInput('');
    setValidationError(null);
    setValidationResult(null);
    setValidating(false);
    setAdding(false);
    setSelectedProjectId(null);
    setSelectedRole('fullstack');
  }, []);

  const close = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const validateRepoPath = useCallback(async (localPath: string) => {
    const trimmed = localPath.trim();
    if (!trimmed) {
      setValidationError('Enter a local repository path.');
      setValidationResult(null);
      return null;
    }

    setValidating(true);
    setValidationError(null);
    setValidationResult(null);

    try {
      const data = await requestJson<{ repo: ValidatedRepoCandidate }>('/api/panel/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'validate', localPath: trimmed }),
      });
      setValidationResult(data.repo);
      setRepoPathInput(data.repo.localPath);
      setSelectedRole(inferRepoRole(data.repo));
      return data.repo;
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'Validation failed.');
      return null;
    } finally {
      setValidating(false);
    }
  }, []);

  const browse = useCallback(async () => {
    setValidationError(null);
    const folderPath = await pickFolderPath();
    if (!folderPath) return;
    setRepoPathInput(folderPath);
    await validateRepoPath(folderPath);
  }, [validateRepoPath]);

  // Honor the submenu's intent: when the operator picked "Use an
  // existing folder" we auto-pop the system folder picker on open so
  // they don't have to click Browse. "Start from scratch" leaves the
  // input focused with a hint placeholder for them to type a new path.
  const autoBrowsedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      autoBrowsedRef.current = false;
      return;
    }
    if (initialMode === 'existing' && !autoBrowsedRef.current) {
      autoBrowsedRef.current = true;
      void browse();
    }
  }, [open, initialMode, browse]);

  const linkRepoToProject = useCallback(async (repo: RepoRegistryEntry) => {
    if (!selectedProject) return;

    await requestJson(`/api/panel/projects/${encodeURIComponent(selectedProject.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoPaths: Array.from(new Set([...selectedProject.repoPaths, repo.localPath])),
      }),
    });

    if (selectedProject.id === 'default') return;

    const data = await requestJson<{ projects?: StoredProject[] }>('/api/projects');
    const storedProject = (data.projects ?? []).find((project) => (
      project.id === selectedProject.id
      || project.name === selectedProject.name
      || project.slug === selectedProject.name.toLowerCase().replace(/\s+/g, '-')
    ));
    if (!storedProject) return;

    await requestJson(`/api/projects/${encodeURIComponent(storedProject.id)}/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoId: repo.id,
        role: selectedRole,
        suggestionOrigin: 'manual',
      }),
    });
  }, [selectedProject, selectedRole]);

  const addRepo = useCallback(async () => {
    const localPath = repoPathInput.trim();
    if (!localPath) {
      setValidationError('Enter a local repository path.');
      return;
    }

    setAdding(true);
    setValidationError(null);

    try {
      const validated = validationResult ?? await validateRepoPath(localPath);
      if (!validated) return;
      const data = await requestJson<{ repo: RepoRegistryEntry }>('/api/panel/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', localPath: validated.localPath }),
      });
      await linkRepoToProject(data.repo);
      await onProjectsChanged?.();
      await onRepoAdded?.(data.repo);
      close();
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'Unable to add repository.');
    } finally {
      setAdding(false);
    }
  }, [
    close,
    linkRepoToProject,
    onProjectsChanged,
    onRepoAdded,
    repoPathInput,
    validateRepoPath,
    validationResult,
  ]);

  return (
    <GlassModal
      open={open}
      onClose={close}
      title="Add repository"
      subtitle="Register a checkout, then optionally place it inside a project so agents inherit the right scope."
      width={620}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        <label
          htmlFor="add-repo-path"
          style={{
            fontSize: 11,
            lineHeight: '14px',
            fontWeight: 650,
            color: 'var(--t-text-secondary)',
            letterSpacing: 0,
          }}
        >
          Folder
        </label>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto auto',
            gap: 8,
            alignItems: 'center',
          }}
        >
          <input
            id="add-repo-path"
            value={repoPathInput}
            onChange={(event) => {
              setRepoPathInput(event.currentTarget.value);
              setValidationResult(null);
              setValidationError(null);
            }}
            placeholder="/Users/you/project"
            disabled={adding}
            style={{
              ...fieldStyle(),
              paddingTop: 8,
              paddingRight: 10,
              paddingBottom: 8,
              paddingLeft: 10,
              fontFamily: '"SF Mono", ui-monospace, monospace',
            }}
          />
          <button
            type="button"
            onClick={() => { void browse(); }}
            disabled={validating || adding}
            style={smallButtonStyle(validating || adding)}
          >
            <FolderOpen size={13} strokeWidth={2} />
            Browse
          </button>
          <button
            type="button"
            onClick={() => { void validateRepoPath(repoPathInput); }}
            disabled={!repoPathInput.trim() || validating || adding}
            style={smallButtonStyle(!repoPathInput.trim() || validating || adding)}
          >
            {validating ? (
              <Loader2 size={13} strokeWidth={2.2} style={{ animation: 'spin 900ms linear infinite' }} />
            ) : (
              <GitBranch size={13} strokeWidth={2} />
            )}
            Scan
          </button>
        </div>
      </div>

      {validationResult ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            padding: 13,
            borderRadius: 12,
            border: '1px solid var(--t-panel-border)',
            background: 'var(--t-bg-card, rgba(148, 163, 184, 0.06))',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                display: 'grid',
                placeItems: 'center',
                color: 'var(--t-accent)',
                background: 'var(--t-accent-soft)',
                flexShrink: 0,
              }}
            >
              <FolderOpen size={18} strokeWidth={1.8} />
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 14,
                  lineHeight: '18px',
                  fontWeight: 650,
                  color: 'var(--t-text)',
                  letterSpacing: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {validationResult.name}
              </div>
              <div
                title={validationResult.localPath}
                style={{
                  marginTop: 2,
                  fontSize: 11,
                  lineHeight: '14px',
                  color: 'var(--t-text-muted)',
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {shortenPath(validationResult.localPath)}
              </div>
            </div>
            <CheckCircle2 size={17} strokeWidth={2.3} style={{ color: '#16a34a', flexShrink: 0 }} />
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            <RepoChip icon={<GitBranch size={11} strokeWidth={2} />} label={validationResult.defaultBranch} />
            <RepoChip
              icon={<Globe size={11} strokeWidth={2} />}
              label={validationResult.remoteUrl ? prettyRemoteLabel(validationResult.remoteUrl) : 'No remote'}
              muted={!validationResult.remoteUrl}
            />
          </div>
        </div>
      ) : null}

      {validationResult ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 150px',
            gap: 10,
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
            <span style={{ fontSize: 11, lineHeight: '14px', fontWeight: 650, color: 'var(--t-text-secondary)' }}>
              Project placement
            </span>
            <select
              value={effectiveProjectId}
              onChange={(event) => setSelectedProjectId(event.currentTarget.value)}
              disabled={adding}
              style={{
                ...fieldStyle(),
                paddingRight: 10,
                paddingLeft: 10,
              }}
            >
              <option value="none">Leave in workspace only</option>
              {visibleProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
            <span style={{ fontSize: 11, lineHeight: '14px', fontWeight: 650, color: 'var(--t-text-secondary)' }}>
              Role
            </span>
            <select
              value={selectedRole}
              onChange={(event) => setSelectedRole(event.currentTarget.value as ProjectRole)}
              disabled={adding || effectiveProjectId === 'none'}
              style={{
                ...fieldStyle(),
                paddingRight: 10,
                paddingLeft: 10,
                opacity: effectiveProjectId === 'none' ? 0.58 : 1,
              }}
            >
              {ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {validationError ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            padding: '9px 10px',
            borderRadius: 10,
            border: '1px solid rgba(239, 68, 68, 0.2)',
            background: 'rgba(254, 226, 226, 0.24)',
            color: '#ef4444',
            fontSize: 12,
            lineHeight: '16px',
          }}
        >
          <AlertCircle size={14} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{validationError}</span>
        </div>
      ) : null}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9 }}>
        <button
          type="button"
          onClick={close}
          disabled={adding}
          style={{
            minHeight: 36,
            paddingTop: 8,
            paddingRight: 14,
            paddingBottom: 8,
            paddingLeft: 14,
            borderRadius: 10,
            border: '1px solid var(--t-btn-secondary-border)',
            background: 'transparent',
            color: 'var(--t-text-secondary)',
            fontSize: 12,
            lineHeight: '16px',
            fontWeight: 600,
            cursor: adding ? 'default' : 'pointer',
            opacity: adding ? 0.5 : 1,
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => { void addRepo(); }}
          disabled={!repoPathInput.trim() || validating || adding}
          style={primaryButtonStyle(!repoPathInput.trim() || validating || adding)}
        >
          {adding ? 'Adding...' : selectedProject ? `Add to ${selectedProject.name}` : 'Add repository'}
        </button>
      </div>
    </GlassModal>
  );
}

function RepoChip({
  icon,
  label,
  muted = false,
}: {
  icon: ReactNode;
  label: string;
  muted?: boolean;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        maxWidth: '100%',
        paddingTop: 4,
        paddingRight: 8,
        paddingBottom: 4,
        paddingLeft: 8,
        borderRadius: 999,
        border: '1px solid var(--t-divider-subtle)',
        background: 'var(--t-input-bg)',
        color: muted ? 'var(--t-text-faint)' : 'var(--t-text-secondary)',
        fontSize: 10.5,
        lineHeight: '13px',
        fontWeight: 600,
        letterSpacing: 0,
      }}
    >
      <span style={{ flexShrink: 0, display: 'inline-flex' }}>{icon}</span>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </span>
  );
}
