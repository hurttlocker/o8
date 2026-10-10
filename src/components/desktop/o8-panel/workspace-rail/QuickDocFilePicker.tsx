'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FloatingSurface } from '../../FloatingSurface';
import { FileTypeIcon } from './FileTypeIcon';
import { repoRelativeFile } from './quick-doc-pins';

type Entry = { name: string; path: string; kind: 'file' | 'directory' };

export function QuickDocFilePicker({ repoPath, selectedFile, pinned, anchor, onPin, onClose }: {
  repoPath: string; selectedFile: string | null; pinned: string[]; anchor: DOMRect;
  onPin: (file: string) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ query: string; entries: Entry[]; error: boolean; truncated: boolean } | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  const current = repoRelativeFile(repoPath, selectedFile);
  const matching = result?.query === query.trim() ? result : null;
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const previousFocus = document.activeElement;
    inputRef.current?.focus();
    const pointer = (event: PointerEvent) => { if (!surfaceRef.current?.contains(event.target as Node)) closeRef.current(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key === 'Tab') {
        const controls = [...surfaceRef.current?.querySelectorAll<HTMLElement>('input,button:not(:disabled)') ?? []];
        const first = controls[0]; const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('pointerdown', pointer); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', key); if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ workspace: repoPath, ...(query.trim() ? { search: query.trim() } : { directory: '.' }) });
      void fetch(`/api/panel/files?${params}`, { signal: controller.signal }).then(async response => {
        if (!response.ok) throw new Error('File search failed');
        const data = await response.json() as { entries: Entry[]; truncated?: boolean };
        if (!controller.signal.aborted) setResult({ query: query.trim(), entries: data.entries.filter(entry => entry.kind === 'file' && repoRelativeFile(repoPath, entry.path) === entry.path), error: false, truncated: Boolean(data.truncated) });
      }).catch(() => { if (!controller.signal.aborted) setResult({ query: query.trim(), entries: [], error: true, truncated: false }); });
    }, query.trim() ? 150 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [attempt, query, repoPath]);
  const entries = current && !query.trim() ? [{ name: current.split('/').pop() ?? current, path: current, kind: 'file' as const }, ...(matching?.entries ?? []).filter(entry => entry.path !== current)] : matching?.entries ?? [];
  const width = Math.min(320, window.innerWidth - 24);
  const left = Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12));
  const top = Math.max(12, Math.min(anchor.bottom + 6, window.innerHeight - 332));
  return createPortal(<FloatingSurface ref={surfaceRef} role="dialog" aria-label="Add a file to Quick docs" style={{ position: 'fixed', zIndex: 10020, left, top, width, borderRadius: 16 }} contentStyle={{ display: 'flex', flexDirection: 'column', padding: 8 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 6, color: 'var(--t-text)', fontSize: 12, fontWeight: 400 }}><span style={{ flex: 1 }}>Pin a file</span><button type="button" aria-label="Close file picker" onClick={onClose} style={{ border: 0, borderRadius: 5, background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer', width: 24, height: 24 }}><svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div>
    <input ref={inputRef} aria-label="Find a file to pin" placeholder="Search files in this repo" value={query} onChange={event => setQuery(event.target.value)} style={{ height: 30, border: '1px solid var(--t-divider-subtle)', borderRadius: 7, background: 'var(--t-input-bg)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)', fontSize: 12, paddingLeft: 9, paddingRight: 9, marginBottom: 5 }} />
    <div style={{ maxHeight: Math.max(80, Math.min(236, window.innerHeight - top - 96)), overflowY: 'auto', overscrollBehavior: 'contain', scrollbarWidth: 'none' }}>
      {entries.map(entry => <button key={entry.path} type="button" aria-label={`${pinned.includes(entry.path) ? 'Pinned' : 'Pin'} ${entry.path}`} disabled={pinned.includes(entry.path)} onClick={() => { onPin(entry.path); onClose(); }}
        onMouseEnter={event => { event.currentTarget.style.background = 'var(--t-hover)'; }} onMouseLeave={event => { event.currentTarget.style.background = 'transparent'; }}
        style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 34, width: '100%', border: 0, borderRadius: 7, background: 'transparent', color: 'var(--t-text)', opacity: pinned.includes(entry.path) ? .5 : 1, cursor: pinned.includes(entry.path) ? 'default' : 'pointer', textAlign: 'left', padding: 6, fontFamily: 'var(--font-sans-system)' }}>
        <FileTypeIcon name={entry.path} /><span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{entry.path}</span><span style={{ color: 'var(--t-text-muted)', fontSize: 10 }}>{pinned.includes(entry.path) ? 'Pinned' : '+'}</span>
      </button>)}
      {!matching ? <div role="status" style={{ padding: 9, color: 'var(--t-text-muted)', fontSize: 12 }}>Loading files...</div> : matching.error ? <div role="status" style={{ padding: 9, color: 'var(--t-text-muted)', fontSize: 12 }}>Couldn&apos;t load files. <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button></div> : !entries.length ? <div role="status" style={{ padding: 9, color: 'var(--t-text-muted)', fontSize: 12 }}>No matching files.</div> : null}
      {matching?.truncated ? <div role="status" style={{ padding: 9, color: 'var(--t-text-muted)', fontSize: 11 }}>Refine your search to see more matches.</div> : null}
    </div>
  </FloatingSurface>, document.body);
}
