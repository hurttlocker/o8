'use client';

import { ProjectsPanel } from './settings/ProjectsPanel';
import { RamsButton } from './settings/shared';
import { useState } from 'react';
import { broadcastProjectsUpdated } from './repo-registry/useProjects';
import { dispatchFocusRepoWorkspaceTab } from '@/lib/desktop/events';

/** Project management uses the existing persisted project and repository APIs. */
export function ProjectsPage({ onClose }: { onClose: () => void }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const openWorkspace = async (projectId: string, repoId: string, repoPath: string) => {
    setOpening(true); setError('');
    try {
      const response = await fetch('/api/panel/projects/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId }) });
      if (!response.ok) throw new Error('Could not open this project. Try again.');
      broadcastProjectsUpdated();
      if (!dispatchFocusRepoWorkspaceTab({ repoId, repoPath })) throw new Error('The workspace is not ready. Try again.');
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open this project.'); }
    finally { setOpening(false); }
  };
  return <main aria-label="Projects" style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'none', background: 'var(--t-chat-surface-bg, var(--t-canvas-bg))' }}>
    <div style={{ maxWidth: 1040, marginLeft: 'auto', marginRight: 'auto', paddingTop: 28, paddingRight: 28, paddingBottom: 64, paddingLeft: 28 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 24 }}><RamsButton variant="ghost" onClick={onClose}>Back to workspace</RamsButton></div>
      {error ? <p role="alert" style={{ color: 'var(--t-text)' }}>{error}</p> : null}
      <ProjectsPanel library opening={opening} onOpenWorkspace={openWorkspace} />
    </div>
  </main>;
}
