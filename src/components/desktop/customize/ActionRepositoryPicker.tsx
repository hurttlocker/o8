'use client';

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';

export type ActionRepository = { name: string; localPath: string };

const choiceStyle: CSSProperties = {
  minHeight: 36, border: '1px solid var(--t-divider)', borderRadius: 8,
  background: 'var(--t-input-bg)', color: 'var(--t-text)', font: 'inherit',
  paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 12,
  textAlign: 'left', cursor: 'pointer',
};

export function ActionRepositoryPicker({ repos, repoPath, onSelect, disabled }: {
  repos: ActionRepository[];
  repoPath?: string | null;
  onSelect: (path: string | null) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const choicesId = useId();
  const selected = repos.find((repo) => repo.localPath === repoPath);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const choose = (path: string | null) => {
    onSelect(path);
    setOpen(false);
    trigger.current?.focus();
  };

  return <div ref={container} onKeyDown={(event) => {
    if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
  }} style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12, fontWeight: 300 }}>
    <span>Action repository</span>
    <button ref={trigger} type="button" aria-label="Choose action repository" aria-expanded={open && !disabled}
      aria-controls={choicesId} disabled={disabled || repos.length === 0} onClick={() => setOpen((value) => !value)}
      style={{ ...choiceStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      {selected?.name ?? (repos.length ? 'Choose repository' : 'No project repositories available')}
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.2" /></svg>
    </button>
    {open && !disabled ? <div id={choicesId} aria-label="Action repository choices" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <button type="button" aria-pressed={!repoPath} onClick={() => choose(null)} style={choiceStyle}>No repository</button>
      {repos.map((repo) => <button key={repo.localPath} type="button" aria-pressed={repo.localPath === repoPath}
        onClick={() => choose(repo.localPath)} style={{ ...choiceStyle, borderColor: repo.localPath === repoPath ? 'var(--t-accent)' : 'var(--t-divider)' }}>
        <span style={{ display: 'block' }}>{repo.name}</span>
        <span style={{ display: 'block', color: 'var(--t-text-muted)', overflowWrap: 'anywhere', marginTop: 3 }}>{repo.localPath}</span>
      </button>)}
    </div> : null}
    <span style={{ color: 'var(--t-text-muted)', overflowWrap: 'anywhere', lineHeight: 1.5 }}>
      {repoPath ? `Selected repository: ${repoPath}` : 'Repository actions need a selected project repository. Other actions can run without one.'}
    </span>
  </div>;
}
