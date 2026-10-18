'use client';

import { ProjectsPanel } from './settings/ProjectsPanel';
import { useState } from 'react';
import { broadcastProjectsUpdated } from './repo-registry/useProjects';
import { dispatchFocusRepoWorkspaceTab } from '@/lib/desktop/events';
import { WORKSPACE_PAGE_MAX_WIDTH, WORKSPACE_PAGE_TOP_PADDING } from './WorkspacePageHeader';

/** Project management uses the existing persisted project and repository APIs. */
export function ProjectsPage({ onClose, initialProjectId = null }: { onClose: () => void; initialProjectId?: string | null }) {
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const openWorkspace = async (projectId: string, repoId: string, repoPath: string) => {
    setOpeningProjectId(projectId); setError('');
    try {
      const response = await fetch('/api/panel/projects/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId }) });
      if (!response.ok) throw new Error('Could not open this project. Try again.');
      broadcastProjectsUpdated();
      if (!dispatchFocusRepoWorkspaceTab({ repoId, repoPath })) throw new Error('The workspace is not ready. Try again.');
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open this project.'); }
    finally { setOpeningProjectId(null); }
  };
  return <main aria-label="Projects" style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'none', background: 'var(--t-chat-surface-bg, var(--t-canvas-bg))' }}>
    <div style={{ maxWidth: WORKSPACE_PAGE_MAX_WIDTH, marginLeft: 'auto', marginRight: 'auto', paddingTop: WORKSPACE_PAGE_TOP_PADDING, paddingRight: 28, paddingBottom: 64, paddingLeft: 28 }}>
      {error ? <p role="alert" style={{ color: 'var(--t-text)' }}>{error}</p> : null}
      <ProjectsPanel library initialProjectId={initialProjectId} openingProjectId={openingProjectId} onOpenWorkspace={openWorkspace} onBackToWorkspace={onClose} />
    </div>
  </main>;
}
