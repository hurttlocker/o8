'use client';

import { useRef, useState } from 'react';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { ProjectWithRepos } from '@/lib/projects/types';
import { FloatingDialog } from '../FloatingDialog';
import { ProjectButton, projectInputStyle } from './project-ui';
import { ProjectGlyph, ProjectIdentity } from './ProjectIdentity';
import { removeProjectRepo, saveProjectGroup, type ProjectCreateAttempt } from './project-group-actions';

export function ProjectGroupDialog({ repos, project, projectId, onClose, onSaved, onAddRepo }: {
  repos: RepoRegistryEntry[];
  project?: { id: string; name: string; repoPaths: string[] };
  projectId?: string;
  onClose: () => void;
  onSaved: (project: ProjectWithRepos) => void | Promise<void>;
  onAddRepo: () => void;
}) {
  const [name, setName] = useState(project?.name ?? '');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set(repos.filter((repo) => project?.repoPaths.includes(repo.localPath)).map((repo) => repo.id)));
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState('');
  // Remember a durable create before switching context, so a failed switch never creates a duplicate.
  const created = useRef<ProjectWithRepos | null>(null);
  const createAttempt = useRef<ProjectCreateAttempt>({});
  const editTargetId = projectId ?? project?.id;
  const unavailable = Boolean(editTargetId && !project);
  const title = editTargetId ? 'Organize project' : 'New project';
  const filtered = repos.filter((repo) => `${repo.name} ${repo.localPath}`.toLowerCase().includes(query.trim().toLowerCase()));
  const submit = async (addAfterSave = false) => {
    if (!name.trim() || saving.current || unavailable) return;
    saving.current = true; setBusy(true); setError('');
    try {
      const saved = created.current ?? await saveProjectGroup({ name, repoIds: [...selected], projectId: editTargetId, attempt: createAttempt.current });
      if (!project) created.current = saved;
      await onSaved(saved); onClose();
      if (addAfterSave) onAddRepo();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save this project. Try again.'); }
    finally { saving.current = false; setBusy(false); }
  };
  const close = () => { if (!saving.current) onClose(); };
  return <FloatingDialog title={title} onClose={close} overlay width={440}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <ProjectIdentity name={name || 'Project'} size={32} />
      <h2 style={{ margin: 0, flex: 1, fontSize: 18, fontWeight: 300, letterSpacing: '-0.2px' }}>{title}</h2>
      <button type="button" aria-label="Close project dialog" onClick={close} disabled={busy} style={{ width: 28, height: 28, padding: 0, flexShrink: 0, display: 'grid', placeItems: 'center', borderRadius: 8, background: 'transparent', border: 0, color: 'var(--t-text-muted)', cursor: 'pointer' }}><ProjectGlyph kind="close" size={15} /></button>
    </div>
    <p style={{ marginTop: 12, marginBottom: 20, fontSize: 12, fontWeight: 300, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>Group the repositories you work on together.</p>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 12, fontWeight: 300 }}>Project name
        <input data-dialog-initial-focus aria-label="Project name" value={name} disabled={busy || unavailable || !!created.current} onChange={(event) => setName(event.currentTarget.value)} placeholder="My project" maxLength={120} style={projectInputStyle} />
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 20, marginBottom: 10, fontSize: 12, color: 'var(--t-text-secondary)' }}><span style={{ flex: 1 }}>Repositories</span><span style={{ color: 'var(--t-text-muted)', fontSize: 11 }}>{selected.size} selected</span></div>
      {repos.length > 4 ? <input aria-label="Search connected repositories" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search repositories…" style={{ boxSizing: 'border-box', width: '100%', height: 32, marginBottom: 8, paddingLeft: 10, border: '1px solid var(--t-divider-subtle)', borderRadius: 8, background: 'var(--t-input-bg)', color: 'var(--t-text)', fontFamily: 'inherit', fontSize: 12 }} /> : null}
      <div style={{ maxHeight: 224, overflowY: 'auto', scrollbarWidth: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {filtered.map((repo) => {
          const checked = selected.has(repo.id);
          const member = project?.repoPaths.includes(repo.localPath);
          return <div key={repo.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button type="button" role="checkbox" aria-checked={checked} aria-label={repo.name} disabled={busy || unavailable || !!created.current || member} onClick={() => setSelected((current) => { const next = new Set(current); if (next.has(repo.id)) next.delete(repo.id); else next.add(repo.id); return next; })} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, padding: 9, border: 0, borderRadius: 9, textAlign: 'left', background: checked ? 'var(--t-hover)' : 'transparent', color: 'var(--t-text)', cursor: member ? 'default' : 'pointer', fontFamily: 'inherit' }}>
              <ProjectIdentity name={repo.name} size={24} />
              <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: 13, fontWeight: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{repo.name}</span><span style={{ display: 'block', marginTop: 2, fontSize: 10, color: 'var(--t-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{repo.remoteUrl?.replace(/^https?:\/\/|\.git$/g, '') || 'Local repository'}</span></span>
              <span style={{ width: 16, height: 16, borderRadius: 5, border: checked ? '1px solid var(--t-accent)' : '1px solid var(--t-divider-strong)', background: checked ? 'var(--t-accent-soft)' : 'transparent', color: 'var(--t-accent)' }}>{checked ? <ProjectGlyph kind="check" size={14} /> : null}</span>
            </button>
            {member && project ? <button type="button" aria-label={`Remove ${repo.name} from project`} title="Remove from this project. Files stay on disk and the repo stays connected." disabled={busy} onClick={() => {
              if (saving.current) return;
              saving.current = true; setBusy(true); setError('');
              void removeProjectRepo(project.id, repo.id).then(() => setSelected((current) => { const next = new Set(current); next.delete(repo.id); return next; })).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not remove this repo.')).finally(() => { saving.current = false; setBusy(false); });
            }} style={{ width: 28, height: 28, padding: 0, flexShrink: 0, display: 'grid', placeItems: 'center', border: 0, borderRadius: 6, background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer' }}><ProjectGlyph kind="close" size={15} /></button> : project ? <span aria-hidden style={{ width: 28, flexShrink: 0 }} /> : null}
          </div>;
        })}
        {filtered.length === 0 ? <p style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>{repos.length ? 'No matching repositories.' : 'Add a repository, then group it here.'}</p> : null}
      </div>
      {project ? <p style={{ marginTop: 9, marginBottom: 0, fontSize: 10.5, lineHeight: 1.4, color: 'var(--t-text-muted)' }}>Removing a repo from this project keeps its files and conversations.</p> : null}
      {unavailable ? <p role="alert" style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>This project is no longer available. Close this dialog and choose another project.</p> : null}
      {error ? <p role="alert" style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--t-danger, var(--t-text-secondary))' }}>{error}</p> : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 22 }}>
        <ProjectButton disabled={busy || unavailable || !name.trim()} onClick={() => { void submit(true); }}><ProjectGlyph kind="add" size={14} />{editTargetId ? 'Save & add repo' : 'Create & add repo'}</ProjectButton>
        <span style={{ flex: 1 }} />
        <ProjectButton disabled={busy} onClick={close}>Cancel</ProjectButton>
        <ProjectButton primary busy={busy} disabled={unavailable || !name.trim()} onClick={() => { void submit(); }}>{busy ? 'Saving…' : created.current ? 'Open project' : editTargetId ? 'Save' : 'Create project'}</ProjectButton>
      </div>
    </form>
  </FloatingDialog>;
}
