'use client';

import type { CSSProperties } from 'react';

export type GithubSourceInput = { repository: string; commit: string; directory: string };
const inputStyle: CSSProperties = { width: '100%', boxSizing: 'border-box', minWidth: 0, minHeight: 30, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider)', borderRadius: 7, backgroundColor: 'var(--t-input-bg)', color: 'var(--t-text)', paddingTop: 6, paddingBottom: 6, paddingLeft: 10, paddingRight: 10, fontFamily: 'var(--font-sans-system)', fontSize: 12 };
const buttonStyle: CSSProperties = { minHeight: 28, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider)', borderRadius: 7, backgroundColor: 'var(--t-input-bg)', color: 'var(--t-text)', paddingTop: 5, paddingBottom: 5, paddingLeft: 10, paddingRight: 10, fontFamily: 'var(--font-sans-system)', fontSize: 12, fontWeight: 300, cursor: 'pointer' };

export function ActionSourceFields({ directory, github, disabled, onDirectory, onGithub, onReview }: {
  directory: string;
  github: GithubSourceInput | null;
  disabled: boolean;
  onDirectory: (value: string) => void;
  onGithub: (value: GithubSourceInput | null) => void;
  onReview: () => void;
}) {
  const field = (key: keyof GithubSourceInput, label: string, placeholder: string) => <label style={{ display: 'block', fontSize: 12, fontWeight: 300 }}>
    <span style={{ display: 'block', marginBottom: 8 }}>{label}</span>
    <input aria-label={label} value={github?.[key] ?? ''} onChange={(event) => onGithub({ ...github!, [key]: event.target.value })} placeholder={placeholder} disabled={disabled} style={inputStyle} />
  </label>;
  return <div>
    <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
      <button type="button" aria-pressed={!github} disabled={disabled} onClick={() => onGithub(null)} style={buttonStyle}>Local folder</button>
      <button type="button" aria-pressed={!!github} disabled={disabled} onClick={() => onGithub({ repository: '', commit: '', directory: '' })} style={buttonStyle}>GitHub source</button>
    </div>
    {github ? <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {field('repository', 'Public GitHub repository', 'owner/repository')}
      {field('commit', 'Exact commit', '40-character commit SHA')}
      {field('directory', 'Package directory (optional)', 'examples/action-plugins/project-setup-check')}
      <div style={{ fontSize: 12, fontWeight: 300, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>Downloads only the declared package files at this commit. Linking and running remain separate actions.</div>
    </div> : <label htmlFor="action-plugin-folder" style={{ display: 'block', fontSize: 12, fontWeight: 300 }}>
      <span style={{ display: 'block', marginBottom: 8 }}>Local plugin folder</span>
      <input id="action-plugin-folder" value={directory} onChange={(event) => onDirectory(event.target.value)} placeholder="Absolute path to a local folder" disabled={disabled} style={inputStyle} />
    </label>}
    <button type="button" onClick={onReview} disabled={disabled || (github ? !github.repository.trim() || !/^[a-f0-9]{40}$/.test(github.commit.trim()) : !directory.trim())} style={{ ...buttonStyle, marginTop: 12 }}>Review files</button>
  </div>;
}
