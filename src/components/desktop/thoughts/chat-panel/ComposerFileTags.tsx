'use client';

import type { CSSProperties } from 'react';

const action: CSSProperties = { border: 0, padding: 0, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' };

/** File references open through the workspace's existing Files viewer. */
export function ComposerFileTags({ paths, repoPath, onRemove }: {
  paths: readonly string[]; repoPath?: string | null; onRemove: (path: string) => void;
}) {
  if (!paths.length) return null;
  return <div aria-label="Referenced files" style={{ display: 'flex', flexWrap: 'wrap', gap: 6,
    paddingTop: 12, paddingRight: 14, paddingBottom: 4, paddingLeft: 14 }}>
    {paths.map(path => <span key={path} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%',
      paddingTop: 4, paddingRight: 6, paddingBottom: 4, paddingLeft: 8,
      border: '1px solid var(--t-border)', borderRadius: 7, background: 'var(--t-hover)',
      color: 'var(--t-text-secondary)', fontSize: 11, lineHeight: '18px' }}>
      <button type="button" aria-label={`Open ${path}`} title={path} onClick={() => {
        const absolute = path.startsWith('/') || /^[A-Z]:[\\/]/i.test(path) || !repoPath ? path : `${repoPath.replace(/\/$/, '')}/${path}`;
        window.dispatchEvent(new CustomEvent('o8:open-file', { detail: { path: absolute } }));
      }} style={{ ...action, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
        <span aria-hidden="true" style={{ color: 'var(--t-text-muted)', marginRight: 4 }}>@</span>{path.split(/[\\/]/).pop()}
      </button>
      <button type="button" aria-label={`Remove reference ${path}`} onClick={() => onRemove(path)}
        style={{ ...action, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18,
          flexShrink: 0, color: 'var(--t-text-muted)', borderRadius: 4 }}>
        <svg aria-hidden="true" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="m3 3 6 6m0-6-6 6" /></svg>
      </button>
    </span>)}
  </div>;
}
