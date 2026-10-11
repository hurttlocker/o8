'use client';

import { useId, useState } from 'react';
import { AllFilesTree } from './AllFilesTree';
import { FileViewer } from './FileViewer';

/** File content and its optional explorer share the same mounted selection. */
export function WorkspaceFilesPane({ repoPath, selectedFile, dirtyFiles, onSelectFile }: {
  repoPath?: string | null;
  selectedFile: string | null;
  dirtyFiles: Set<string>;
  onSelectFile: (path: string) => void;
}) {
  const [treeVisible, setTreeVisible] = useState(true);
  const treeId = useId();
  const label = treeVisible ? 'Hide file tree' : 'Show file tree';
  const split = treeVisible && Boolean(selectedFile);
  const toggle = <button type="button" aria-label={label} title={label} aria-expanded={treeVisible} aria-controls={treeId}
    onClick={() => setTreeVisible(current => !current)}
    onMouseEnter={event => { event.currentTarget.style.background = 'var(--t-hover)'; }}
    onMouseLeave={event => { event.currentTarget.style.background = 'transparent'; }}
    style={{ flexShrink: 0, width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0,
      border: 0, borderRadius: 7, background: 'transparent', color: treeVisible ? 'var(--t-text-secondary)' : 'var(--t-accent)', cursor: 'pointer' }}>
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="3" /><path d="M15 4v16" />
      <path d={treeVisible ? 'm17 9 2 3-2 3' : 'm19 9-2 3 2 3'} />
    </svg>
  </button>;

  return <div data-workspace-files="" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'grid',
    gridTemplateColumns: split ? 'minmax(0, 1fr) minmax(min(210px, 48%), 34%)' : 'minmax(0, 1fr)', background: 'var(--t-bg)' }}>
    {selectedFile ? <FileViewer repoPath={repoPath} selectedFile={selectedFile} headerAction={toggle} /> : null}
    <div id={treeId} hidden={!treeVisible && Boolean(selectedFile)} style={{ minWidth: 0, minHeight: 0, display: treeVisible || !selectedFile ? 'flex' : 'none',
      borderLeft: split ? '1px solid var(--t-divider-subtle)' : undefined, background: 'transparent' }}>
      <AllFilesTree repoPath={repoPath} selectedFile={selectedFile} dirtyFiles={dirtyFiles} onSelectFile={onSelectFile} />
    </div>
  </div>;
}
