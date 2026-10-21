'use client';

import { useEffect, useId, useRef, type CSSProperties } from 'react';
import { useTheme } from '@/lib/theme/context';
import { PrFileTree } from './PrFileTree';
import type { PrFile } from './types';

const iconStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, padding: 0, border: 0, borderRadius: 7, color: 'var(--t-text-muted)', background: 'transparent', cursor: 'pointer', flexShrink: 0 };
function Glyph({ kind }: { kind: 'fold' | 'unified' | 'split' | 'tree' }) {
  const paths = { fold: 'm8 8 4-4 4 4M8 16l4 4 4-4', unified: 'M4 4h16v16H4zM4 10h16M4 15h16', split: 'M4 4h16v16H4zM12 4v16', tree: 'M4 4v14h5M4 9h5M12 6h8v6h-8zM12 15h8v6h-8z' };
  return <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}
export function PrChangesToolbar({ files, totalFiles, additions, deletions, allOpen, onSetOpenFiles, diffStyle, onDiffStyleChange, treeOpen, onTreeOpenChange, collapsedFolders, onToggleFolder, onNavigate }: {
  files: PrFile[]; totalFiles: number; additions: number; deletions: number; allOpen: boolean; onSetOpenFiles?: (paths: string[]) => void;
  diffStyle: 'unified' | 'split'; onDiffStyleChange?: (style: 'unified' | 'split') => void; treeOpen: boolean; onTreeOpenChange?: (open: boolean) => void; collapsedFolders: string[]; onToggleFolder?: (path: string) => void; onNavigate?: (path: string) => void;
}) {
  const id = useId(); const trigger = useRef<HTMLButtonElement>(null); const tree = useRef<HTMLDivElement>(null); const toolbar = useRef<HTMLDivElement>(null);
  const { workspaceGlass } = useTheme();
  useEffect(() => {
    if (!treeOpen) return;
    const close = (event: PointerEvent) => { if (!toolbar.current?.contains(event.target as Node)) onTreeOpenChange?.(false); };
    document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close);
  }, [treeOpen, onTreeOpenChange]);
  return <div ref={toolbar} data-pr-changes-toolbar style={{ position: 'relative', flexShrink: 0, zIndex: 3, background: 'var(--t-panel)', borderBottom: '1px solid var(--t-divider-subtle)' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 40, boxSizing: 'border-box', paddingTop: 6, paddingRight: 18, paddingBottom: 6, paddingLeft: 18 }}>
      <span style={{ fontSize: 11, color: 'var(--t-text-muted)', whiteSpace: 'nowrap' }}>{totalFiles} file{totalFiles === 1 ? '' : 's'}</span>
      <span aria-label={`${additions} additions, ${deletions} deletions`} style={{ display: 'inline-flex', gap: 5, fontSize: 11, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}><span style={{ color: 'var(--t-success)' }}>+{additions.toLocaleString()}</span><span style={{ color: 'var(--t-danger)' }}>−{deletions.toLocaleString()}</span></span>
      <span style={{ flex: 1 }} />
      {onSetOpenFiles ? <button type="button" aria-label={allOpen ? 'Collapse all files' : 'Expand all files'} title={allOpen ? 'Collapse all files' : 'Expand all files'} onClick={() => onSetOpenFiles(allOpen ? [] : files.map((file) => file.path))} style={iconStyle}><Glyph kind="fold" /></button> : null}
      {onDiffStyleChange ? <div role="group" aria-label="Diff layout" style={{ display: 'flex', padding: 2, borderRadius: 9, border: '1px solid var(--t-border)', background: 'var(--t-hover)' }}>
        {(['unified', 'split'] as const).map((style) => <button key={style} type="button" aria-label={style === 'unified' ? 'Stacked diff' : 'Split diff'} title={style === 'unified' ? 'Stacked diff' : 'Split diff'} aria-pressed={diffStyle === style} onClick={() => onDiffStyleChange(style)} style={{ ...iconStyle, height: 24, width: 26, background: diffStyle === style ? 'var(--t-input-bg)' : 'transparent', color: diffStyle === style ? 'var(--t-text)' : 'var(--t-text-muted)' }}><Glyph kind={style} /></button>)}
      </div> : null}
      {onTreeOpenChange ? <button ref={trigger} id={`${id}-trigger`} type="button" aria-label="Changed file tree" title="Changed file tree" aria-expanded={treeOpen} aria-controls={treeOpen ? id : undefined} onClick={() => { const next = !treeOpen; onTreeOpenChange(next); if (next) window.requestAnimationFrame(() => tree.current?.querySelector<HTMLElement>('summary,button')?.focus()); }} style={{ ...iconStyle, color: treeOpen ? 'var(--t-text)' : 'var(--t-text-muted)', background: treeOpen ? 'var(--t-hover)' : 'transparent' }}><Glyph kind="tree" /></button> : null}
    </div>
    {treeOpen ? <div ref={tree} id={id} role="region" aria-labelledby={`${id}-trigger`} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onTreeOpenChange?.(false); trigger.current?.focus(); } }} style={{ position: 'absolute', right: 12, top: 46, width: 'min(360px, calc(100% - 24px))', maxHeight: 'min(360px, 50vh, max(80px, calc(100cqh - var(--pr-composer-occlusion, 60px) - 70px)))', overflowY: 'auto', overscrollBehavior: 'contain', border: '1px solid var(--t-border)', borderRadius: 12, background: 'var(--t-popover-surface)', color: 'var(--t-text)', boxShadow: 'var(--t-panel-shadow)', backdropFilter: workspaceGlass ? 'blur(22px) saturate(1.2)' : 'none', WebkitBackdropFilter: workspaceGlass ? 'blur(22px) saturate(1.2)' : 'none' }}><PrFileTree files={files} collapsedFolders={collapsedFolders} onToggleFolder={onToggleFolder || (() => {})} onSelect={(path) => { onTreeOpenChange?.(false); onNavigate?.(path); }} /></div> : null}
  </div>;
}
