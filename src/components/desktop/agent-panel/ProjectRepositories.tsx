'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { ComposerPopover } from '../thoughts/chat-panel/ComposerPopover';
import { FloatingSurface } from '../FloatingSurface';
import { ProjectGlyph, ProjectIdentity } from './ProjectIdentity';

const chipStyle = { display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 24,
  paddingTop: 3, paddingRight: 7, paddingBottom: 3, paddingLeft: 4, border: 0, borderRadius: 7,
  color: 'var(--t-text-secondary)', fontFamily: 'inherit', fontSize: 10.5, fontWeight: 300,
  whiteSpace: 'nowrap' as const, boxSizing: 'border-box' as const };

/** Keep the selected repository in sight; disclose only the chips that fit. */
export function ProjectRepositories({ repos, selectedRepoPath, onSelect }: {
  repos: RepoRegistryEntry[];
  selectedRepoPath: string | null;
  onSelect: (path: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const [visibleCount, setVisibleCount] = useState(1);
  const [open, setOpen] = useState(false);
  const ordered = useMemo(() => {
    const selected = repos.find(repo => repo.localPath === selectedRepoPath) ?? repos[0];
    return selected ? [selected, ...repos.filter(repo => repo.id !== selected.id)] : [];
  }, [repos, selectedRepoPath]);
  const identity = ordered.map(repo => `${repo.id}:${repo.name}`).join('|');
  useLayoutEffect(() => {
    const row = host.current;
    if (!row) return;
    const measure = () => {
      const widths = Array.from(row.querySelectorAll<HTMLElement>('[data-repository-measure]')).map(node => node.offsetWidth);
      const available = row.clientWidth;
      if (!available || !widths.length) return;
      const allFit = widths.length <= 3 && widths.reduce((sum, width) => sum + width, 0) + (widths.length - 1) * 3 <= available;
      let count = allFit ? widths.length : 1;
      if (!allFit) {
        let used = widths[0];
        for (let index = 1; index < Math.min(3, widths.length); index += 1) {
          if (used + 3 + widths[index] + 41 > available) break;
          used += 3 + widths[index]; count += 1;
        }
      }
      setVisibleCount(value => value === count ? value : count);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    row.querySelectorAll<HTMLElement>('[data-repository-measure]').forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [identity]);
  const visible = ordered.slice(0, visibleCount);
  const remaining = ordered.slice(visibleCount);
  const select = (repo: RepoRegistryEntry) => { onSelect(repo.localPath); setOpen(false); anchor.current?.focus(); };
  const contents = (repo: RepoRegistryEntry) => <><span style={{ flexShrink: 0, display: 'inline-flex' }}><ProjectIdentity name={repo.name} size={14} /></span><span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{repo.name}</span></>;
  return <div style={{ paddingLeft: 37, paddingRight: 6, paddingBottom: 5, minWidth: 0 }}>
    <div ref={host} aria-label="Project repositories" style={{ position: 'relative', display: 'flex', gap: 3, alignItems: 'center', minWidth: 0 }}>
      <div aria-hidden inert style={{ position: 'absolute', visibility: 'hidden', pointerEvents: 'none', display: 'flex', top: 0, left: 0 }}>
        {ordered.map(repo => <span key={repo.id} data-repository-measure style={{ ...chipStyle, flexShrink: 0, width: 'max-content', maxWidth: 140 }}>{contents(repo)}</span>)}
      </div>
      {visible.map((repo, index) => <button key={repo.id} data-repository-chip type="button" title={repo.name}
        aria-label={`Open ${repo.name} repository`} aria-pressed={repo.localPath === selectedRepoPath}
        onClick={() => onSelect(repo.localPath)}
        onMouseEnter={event => { event.currentTarget.style.background = 'var(--t-hover)'; }}
        onMouseLeave={event => { event.currentTarget.style.background = repo.localPath === selectedRepoPath ? 'var(--t-hover)' : 'transparent'; }}
        style={{ ...chipStyle, cursor: 'pointer', minWidth: 0, flexShrink: index === 0 ? 1 : 0,
          maxWidth: remaining.length && visible.length === 1 ? 'min(140px, calc(100% - 41px))' : 140,
          background: repo.localPath === selectedRepoPath ? 'var(--t-hover)' : 'transparent' }}>{contents(repo)}</button>)}
      {remaining.length ? <button ref={anchor} type="button" aria-label={`${remaining.length} more repositories`}
        title="More repositories" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}
        style={{ ...chipStyle, display: 'inline-flex', justifyContent: 'center', width: 38, flexShrink: 0,
          paddingLeft: 4, paddingRight: 4, gap: 2, cursor: 'pointer', background: open ? 'var(--t-hover)' : 'transparent' }}>
        +{remaining.length}<ProjectGlyph kind="chevron" size={10} />
      </button> : null}
      <ComposerPopover anchorRef={anchor} open={open && remaining.length > 0} align="start" onClose={() => setOpen(false)}>
        <FloatingSurface overlay style={{ width: 'min(280px, calc(100vw - 24px))', borderRadius: 14 }} contentStyle={{ padding: 6 }}>
          <div role="menu" aria-label="More repositories" style={{ maxHeight: 'min(320px, calc(100vh - 48px))', overflowY: 'auto', scrollbarWidth: 'none' }}>
            {remaining.map(repo => <button key={repo.id} type="button" role="menuitem" aria-label={`Open ${repo.name} repository`}
              title={repo.name} onClick={() => select(repo)} onMouseEnter={event => { event.currentTarget.style.background = 'var(--t-hover)'; }}
              onMouseLeave={event => { event.currentTarget.style.background = 'transparent'; }}
              style={{ ...chipStyle, width: '100%', minHeight: 34, paddingLeft: 8, paddingRight: 8,
                fontSize: 12, textAlign: 'left', background: 'transparent', cursor: 'pointer' }}>{contents(repo)}</button>)}
          </div>
        </FloatingSurface>
      </ComposerPopover>
    </div>
  </div>;
}
