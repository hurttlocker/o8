'use client';

import { O8HandoffsPane } from '../O8HandoffsPane';
import { O8ThreadsPane } from './O8ThreadsPane';
import type { RepoRegistryEntry } from '@/lib/repos/types';

export function O8ThreadTools({ active, exchanges, onViewChange, repoPath, repos, allRepos, onRepoPathChange, selection }: {
  active: boolean;
  exchanges: boolean;
  onViewChange: (exchanges: boolean) => void;
  repoPath: string | null;
  repos: RepoRegistryEntry[];
  allRepos: boolean;
  onRepoPathChange?: (repoPath: string) => void;
  selection: { id: string | null; request: number; repoPath: string | null };
}) {
  return <>
    <div role="tablist" aria-label="Thread views" style={{ display: 'flex', gap: 4, paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12, borderBottom: '1px solid var(--t-divider-subtle)', flexShrink: 0 }}>
      {[{ label: 'Tasks', value: false }, { label: 'Exchanges', value: true }].map((view) => <button key={view.label} type="button" role="tab" tabIndex={exchanges === view.value ? 0 : -1} aria-selected={exchanges === view.value} onClick={() => onViewChange(view.value)} onKeyDown={(event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); onViewChange(!exchanges); (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[exchanges ? 0 : 1])?.focus(); }
      }} style={{ height: 26, paddingTop: 0, paddingRight: 10, paddingBottom: 0, paddingLeft: 10, border: 0, borderRadius: 7, background: exchanges === view.value ? 'var(--t-input-bg)' : 'transparent', color: exchanges === view.value ? 'var(--t-text)' : 'var(--t-text-muted)', fontFamily: 'var(--font-sans-system)', fontSize: 12, fontWeight: 300, cursor: 'pointer' }}>{view.label}</button>)}
    </div>
    <div style={{ flex: 1, minHeight: 0, display: exchanges ? 'none' : 'flex', flexDirection: 'column' }}><O8ThreadsPane active={active && !exchanges} repoPath={repoPath} repos={repos} allRepos={allRepos} /></div>
    <div style={{ flex: 1, minHeight: 0, display: exchanges ? 'flex' : 'none', flexDirection: 'column' }}><O8HandoffsPane active={active && exchanges} repoPath={repoPath} registeredRepos={repos} allRepos={allRepos} onRepoPathChange={onRepoPathChange} selection={selection} /></div>
  </>;
}
