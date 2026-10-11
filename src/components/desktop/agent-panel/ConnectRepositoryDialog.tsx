'use client';

import { useEffect, useRef, useState } from 'react';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { OPEN_SETTINGS_TAB_EVENT } from '@/lib/desktop/events';
import { isVirtualRepoProjectId } from '@/lib/repos/virtual-project-id';
import { FloatingDialog } from '../FloatingDialog';
import { requestJson } from '../repo-registry/shared';
import { GitHubIcon } from '../settings/shared';
import type { ProjectRecord } from '../repo-registry/useProjects';
import { ProjectGlyph, ProjectIdentity } from './ProjectIdentity';
import { connectRepository, type RepositoryConnectAttempt, type RepositorySource } from './repository-source-actions';
import { ProjectButton, projectInputStyle } from './project-ui';

interface GithubRepo { full_name: string; clone_url: string; private: boolean; description?: string | null }

export function ConnectRepositoryDialog({ source, projects, activeProjectId, onClose, onConnected }: {
  source: RepositorySource; projects: ProjectRecord[]; activeProjectId: string | null;
  onClose: () => void; onConnected: (repo: RepoRegistryEntry, project?: ProjectRecord) => void | Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [selectedProject, setSelectedProject] = useState(activeProjectId ?? 'none');
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const attempt = useRef<RepositoryConnectAttempt>({});
  const [error, setError] = useState('');
  const [github, setGithub] = useState<{ loading: boolean; authenticated?: boolean; repos: GithubRepo[]; error?: string }>({ loading: source === 'github', repos: [] });
  const [revision, setRevision] = useState(0);
  const available = projects.filter((project) => project.id !== 'default' && !isVirtualRepoProjectId(project.id));
  const project = available.find((entry) => entry.id === selectedProject);
  const close = () => { if (!running.current) onClose(); };
  useEffect(() => {
    if (source !== 'github') return;
    let alive = true;
    setGithub({ loading: true, repos: [] });
    void requestJson<{ authenticated: boolean }>('/api/panel/github-status').then(async (status) => {
      if (!alive) return;
      if (!status.authenticated) { setGithub({ loading: false, authenticated: false, repos: [] }); return; }
      const data = await requestJson<{ repos: GithubRepo[] }>('/api/panel/repos?source=github&limit=100');
      if (alive) setGithub({ loading: false, authenticated: true, repos: data.repos });
    }).catch(() => { if (alive) setGithub({ loading: false, repos: [], error: 'Could not load GitHub repositories. Retry or paste a URL below.' }); });
    return () => { alive = false; };
  }, [source, revision]);
  const submit = async () => {
    if (running.current || !value.trim()) return;
    running.current = true; setBusy(true); setError('');
    try {
      const repo = await connectRepository({ source, value, project, attempt: attempt.current });
      await onConnected(repo, project); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not connect this repository. Try again.'); }
    finally { running.current = false; setBusy(false); }
  };
  const terms = value.toLowerCase().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').trim();
  const shown = github.repos.filter((repo) => repo.full_name.toLowerCase().includes(terms)).slice(0, 30);
  const title = source === 'new' ? 'New repository' : source === 'github' ? 'Add from GitHub' : 'Add from Git URL';
  return <FloatingDialog title={title} onClose={close} overlay width={460}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ color: 'var(--t-text-secondary)' }}>{source === 'github' ? <GitHubIcon size={21} /> : <ProjectGlyph kind={source === 'new' ? 'add' : 'link'} size={21} />}</span>
      <h2 style={{ margin: 0, flex: 1, fontSize: 18, fontWeight: 300, letterSpacing: '-0.2px' }}>{title}</h2>
      <button type="button" disabled={busy} aria-label="Close repository dialog" onClick={close} style={{ width: 28, height: 28, padding: 0, flexShrink: 0, display: 'grid', placeItems: 'center', border: 0, borderRadius: 8, background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer' }}><ProjectGlyph kind="close" size={15} /></button>
    </div>
    <p style={{ fontSize: 12, lineHeight: 1.5, fontWeight: 300, color: 'var(--t-text-secondary)', marginTop: 12, marginBottom: 18 }}>{source === 'new' ? 'Start a Git repository in a new folder.' : source === 'github' ? 'Choose a repository or paste its GitHub URL.' : 'Clone from GitHub, GitLab, Bitbucket, Azure DevOps, or another Git host.'}</p>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 12, fontWeight: 300 }}>
        {source === 'new' ? 'Folder path' : 'Repository'}
        <input data-dialog-initial-focus aria-label={source === 'new' ? 'New repository folder' : 'Repository URL'} value={value} disabled={busy || !!attempt.current.repo} onChange={(event) => setValue(event.currentTarget.value)} placeholder={source === 'new' ? '~/Developer/my-app' : source === 'github' ? 'Search, owner/repo, or GitHub URL' : 'https://… or git@host:owner/repo.git'} autoComplete="off" spellCheck={false} style={projectInputStyle} />
      </label>
      {source === 'github' ? <div style={{ marginTop: 9, height: github.authenticated || github.loading ? 222 : undefined, overflowY: 'auto', scrollbarWidth: 'none' }}>
        {github.loading ? <p role="status" style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>Loading repositories…</p> : null}
        {github.authenticated === false ? <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>Connect GitHub to browse your repositories. You can also paste a public repository URL.</p> : null}
        {github.error ? <p role="status" style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>{github.error}</p> : null}
        {shown.map((repo) => <button key={repo.full_name} type="button" aria-label={`Choose ${repo.full_name}`} disabled={busy || !!attempt.current.repo} onClick={() => setValue(repo.clone_url)} onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }} onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', minHeight: 38, padding: 7, border: 0, borderRadius: 8, background: 'transparent', color: 'var(--t-text)', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
          <ProjectIdentity name={repo.full_name.split('/').at(-1)!} size={20} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 300 }}>{repo.full_name}</span>
          {repo.private ? <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>Private</span> : null}
        </button>)}
        {!github.loading && github.authenticated && !shown.length ? <p style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>No matching repositories in the recent list. Paste an owner/repo or URL to add another.</p> : null}
      </div> : null}
      {source === 'github' && !github.loading && (github.authenticated === false || github.error) ? <div style={{ display: 'flex', gap: 8, marginTop: 8 }}><ProjectButton disabled={busy} onClick={() => { close(); window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_TAB_EVENT, { detail: { tab: 'git-prs' } })); }}>GitHub connections</ProjectButton><ProjectButton disabled={busy} onClick={() => setRevision((count) => count + 1)}>Retry</ProjectButton></div> : null}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 18, fontSize: 12, fontWeight: 300 }}>Add to project
        <select aria-label="Repository project" value={project?.id ?? 'none'} onChange={(event) => setSelectedProject(event.currentTarget.value)} disabled={busy} style={projectInputStyle}><option value="none">Keep as a standalone repo</option>{available.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select>
      </label>
      <p style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--t-text-muted)', marginTop: 9 }}>{source === 'new' ? 'Creates the folder and initial Git repository.' : 'Uses saved Git/CLI credentials. New clones go in ~/Developer; connected repos are reused.'}</p>
      {error ? <p role="alert" style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--t-danger, var(--t-text-secondary))' }}>{error}</p> : null}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}><ProjectButton disabled={busy} onClick={close}>Cancel</ProjectButton><ProjectButton primary disabled={!value.trim()} busy={busy} onClick={() => { void submit(); }}>{busy ? 'Connecting…' : attempt.current.repo ? 'Retry connection' : source === 'new' ? 'Create repository' : 'Add repository'}</ProjectButton></div>
    </form>
  </FloatingDialog>;
}
