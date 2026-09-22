'use client';

import type { CSSProperties } from 'react';
import { RamsButton } from '../settings/shared';

export type CustomizeTab = 'rules' | 'commands' | 'prompts' | 'skills' | 'plugins' | 'connections' | 'agents' | 'hooks';

const TABS: Array<{ id: CustomizeTab; label: string }> = [
  { id: 'rules', label: 'Rules' },
  { id: 'commands', label: 'Commands' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'skills', label: 'Skills' },
  { id: 'connections', label: 'Connections' },
  { id: 'agents', label: 'Agents' },
  { id: 'hooks', label: 'Hooks' },
];

const fieldStyle: CSSProperties = {
  minWidth: 0, minHeight: 36, border: '1px solid var(--t-divider)', borderRadius: 8,
  background: 'var(--t-input-bg)', color: 'var(--t-text)', font: 'inherit',
  paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 12,
};

export function CustomizeHeader({ tab, onTab, query, onQuery, repos, repoPath, onRepo, counts, onClose }: {
  tab: CustomizeTab;
  onTab: (tab: CustomizeTab) => void;
  query: string;
  onQuery: (query: string) => void;
  repos: Array<{ name: string; localPath: string }>;
  repoPath: string | null;
  onRepo: (path: string | null) => void;
  counts: Partial<Record<CustomizeTab, number>>;
  onClose?: () => void;
}) {
  const tabs = process.env.NODE_ENV === 'development'
    ? [...TABS.slice(0, 4), { id: 'plugins' as const, label: 'Plugins' }, ...TABS.slice(4)]
    : TABS;
  const label = tabs.find((item) => item.id === tab)?.label ?? 'customizations';
  const repoName = repos.find((repo) => repo.localPath === repoPath)?.name ?? 'Personal';
  return (
    <header style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <h1 style={{ marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, fontSize: 28, fontWeight: 400, letterSpacing: '-0.8px', color: 'var(--t-text)' }}>Customize</h1>
          {onClose ? <RamsButton variant="ghost" onClick={onClose}>Back to workspace</RamsButton> : null}
        </div>
        <p style={{ marginTop: 12, marginBottom: 0, fontSize: 14, lineHeight: 1.6, color: 'var(--t-text-muted)' }}>
          Shape how your agents work. Keep shared tools and project guidance in one place.
        </p>
      </div>
      <nav aria-label="Customization sections" style={{ display: 'flex', flexWrap: 'wrap', columnGap: 22, rowGap: 4, borderBottom: '1px solid var(--t-divider-subtle)' }}>
        {tabs.map((item) => (
          <button key={item.id} type="button" aria-pressed={tab === item.id} onClick={() => onTab(item.id)} style={{
            minHeight: 44, display: 'inline-flex', alignItems: 'center', gap: 6, paddingTop: 10, paddingBottom: 10,
            paddingLeft: 0, paddingRight: 0, border: 'none', borderRadius: 0, borderBottom: `2px solid ${tab === item.id ? 'var(--t-accent)' : 'transparent'}`,
            background: 'transparent', color: tab === item.id ? 'var(--t-text)' : 'var(--t-text-muted)',
            fontSize: 13, fontWeight: 300, fontFamily: 'inherit', cursor: 'pointer',
          }}>
            {item.label}
            {item.id === 'plugins' ? <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>Preview</span>
              : counts[item.id] ? <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{counts[item.id]}</span> : null}
          </button>
        ))}
      </nav>
      {tab !== 'plugins' ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
          <input aria-label={`Search ${label}`} placeholder={`Search ${label} for ${repoName}…`} value={query} onChange={(event) => onQuery(event.target.value)}
            style={{ ...fieldStyle, flex: '1 1 200px', fontSize: 13 }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--t-text-muted)', maxWidth: '100%' }}>
            Context
            <select aria-label="Customization context" value={repoPath ?? ''} onChange={(event) => onRepo(event.target.value || null)} style={{ ...fieldStyle, maxWidth: 240 }}>
              <option value="">Personal</option>
              {repos.map((repo) => <option key={repo.localPath} value={repo.localPath}>{repo.name}</option>)}
            </select>
          </label>
        </div>
      ) : null}
    </header>
  );
}
