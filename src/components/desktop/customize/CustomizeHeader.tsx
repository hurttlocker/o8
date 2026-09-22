'use client';

import type { CSSProperties } from 'react';
import type { ProjectRecord } from '../repo-registry/useProjects';
import { RamsButton } from '../settings/shared';

export type CustomizeTab = 'rules' | 'commands' | 'prompts' | 'skills' | 'plugins' | 'connections' | 'agents' | 'hooks';

const TABS: Array<{ id: CustomizeTab; label: string }> = [
  { id: 'rules', label: 'Instructions' },
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

export function CustomizeHeader({ tab, onTab, query, onQuery, repos, scope, onScope, project, counts, onClose }: {
  tab: CustomizeTab;
  onTab: (tab: CustomizeTab) => void;
  query: string;
  onQuery: (query: string) => void;
  repos: Array<{ name: string; localPath: string }>;
  scope: string;
  onScope: (scope: string) => void;
  project?: ProjectRecord | null;
  counts: Partial<Record<CustomizeTab, number>>;
  onClose?: () => void;
}) {
  const tabs = process.env.NODE_ENV === 'development'
    ? [...TABS.slice(0, 4), { id: 'plugins' as const, label: 'Plugins' }, ...TABS.slice(4)]
    : TABS;
  const label = tabs.find((item) => item.id === tab)?.label ?? 'customizations';
  const repoName = scope === 'personal' || !project ? 'Personal' : repos.find((repo) => repo.localPath === scope)?.name ?? project.name;
  const filtersRepositories = ['rules', 'skills', 'prompts', 'agents', 'hooks'].includes(tab);
  const explanations: Record<CustomizeTab, string> = {
    rules: 'Project instructions are shared guidance. Additional rules below show their own scope and source.',
    skills: 'Review skills found in this project and your personal folders. Expand a skill to inspect its source copies.',
    prompts: 'Saved text you choose to insert into a task. Choose Personal or a repository when saving a prompt.',
    commands: 'Built-in shortcuts for the orchestrator. Type / in the composer to use them in your current task.',
    connections: 'Manage connected services once in Settings. Access during a task depends on the agent and its permissions.',
    agents: 'Agent definitions found in personal and repository folders. These entries currently come from Claude Code configuration.',
    hooks: 'Configured commands that run on agent events. These entries currently come from Claude Code configuration.',
    plugins: 'A design preview with sample packages. It does not change this project or install tools.',
  };
  return (
    <header style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <h1 style={{ marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, fontSize: 28, fontWeight: 400, letterSpacing: '-0.8px', color: 'var(--t-text)' }}>Customize</h1>
          {onClose ? <RamsButton variant="ghost" onClick={onClose}>Back to workspace</RamsButton> : null}
        </div>
        <p style={{ marginTop: 12, marginBottom: 0, fontSize: 14, lineHeight: 1.6, color: 'var(--t-text-muted)' }}>
          {project ? `${project.name} · ${project.repoPaths.length} ${project.repoPaths.length === 1 ? 'repository' : 'repositories'}` : 'Personal customizations'}
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
          {filtersRepositories ? <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--t-text-muted)', maxWidth: '100%' }}>
            Show
            <select aria-label="Customization view" value={scope} onChange={(event) => onScope(event.target.value)} style={{ ...fieldStyle, maxWidth: 240 }}>
              <option value="all">{project ? 'All project repositories + personal' : 'Personal'}</option>
              {project ? <option value="personal">Personal only</option> : null}
              {repos.map((repo) => <option key={repo.localPath} value={repo.localPath}>{repo.name} + personal</option>)}
            </select>
          </label> : <span style={{ color: 'var(--t-text-muted)', fontSize: 12 }}>Shared across projects</span>}
        </div>
      ) : null}
      <p style={{ marginTop: 0, marginBottom: 0, color: 'var(--t-text-muted)', fontSize: 13, lineHeight: 1.6 }}>{explanations[tab]}{filtersRepositories && project ? ' This view filters the list; it does not change your task’s repository.' : ''}</p>
    </header>
  );
}
