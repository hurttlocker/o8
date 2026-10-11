'use client';

import { useEffect, useMemo, useState } from 'react';
import { FileTypeIcon } from './FileTypeIcon';
import { QuickDocFilePicker } from './QuickDocFilePicker';
import { useQuickDocPins } from './quick-doc-pins';

const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

interface QuickDocEntry {
  label: string;
  value: string;
  path: string;
}

interface QuickDocGroup {
  label: 'Global' | 'This repo';
  entries: QuickDocEntry[];
}

interface QuickDocsResponse {
  groups?: QuickDocGroup[];
}

const EMPTY_GROUPS: QuickDocGroup[] = [];

function ChevronIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function displayPathForEntry(entryPath: string, repoPath?: string | null) {
  if (entryPath.startsWith('/')) return entryPath;
  if (!repoPath?.startsWith('/')) return entryPath;
  return `${repoPath.replace(/\/$/, '')}/${entryPath.replace(/^\//, '')}`;
}

export function QuickDocs({
  repoPath,
  selectedFile,
  onSelectFile,
}: {
  repoPath?: string | null;
  selectedFile: string | null;
  onSelectFile: (filePath: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);
  const pins = useQuickDocPins(repoPath);
  const [snapshot, setSnapshot] = useState<{ repoPath: string | null; groups: QuickDocGroup[] }>({ repoPath: null, groups: [] });
  const groups = snapshot.repoPath === (repoPath ?? null) ? snapshot.groups : EMPTY_GROUPS;

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (repoPath) params.set('workspace', repoPath);
    const query = params.toString();

    fetch(`/api/v2/files/quick-docs${query ? `?${query}` : ''}`)
      .then((response) => response.json() as Promise<QuickDocsResponse>)
      .then((data) => {
        if (!cancelled) setSnapshot({ repoPath: repoPath ?? null, groups: Array.isArray(data.groups) ? data.groups : [] });
      })
      .catch(() => {
        if (!cancelled) setSnapshot({ repoPath: repoPath ?? null, groups: [] });
      });

    return () => { cancelled = true; };
  }, [repoPath]);

  const total = useMemo(
    () => groups.reduce((sum, group) => sum + group.entries.length, 0) + pins.paths.length,
    [groups, pins.paths],
  );

  if (total === 0 && !repoPath) return null;

  return (
    <div style={{ borderBottom: '1px solid var(--t-divider-subtle)', background: 'transparent', flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
      <button type="button" aria-label="Quick docs" aria-expanded={expanded} onClick={() => setExpanded(open => !open)} style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', cursor: 'pointer', minHeight: 30, display: 'flex', alignItems: 'center', gap: 8, paddingTop: 0, paddingRight: 10, paddingBottom: 0, paddingLeft: 12 }}>
        <span style={{ display: 'inline-flex', transform: expanded ? 'rotate(90deg)' : 'none' }}><ChevronIcon size={10} /></span>
        <span style={{ color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 11, fontWeight: 400, letterSpacing: 0 }}>
          Quick docs
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--t-text-faint)', fontFamily: MONO_FONT, fontSize: 10, fontWeight: 650 }}>
          {total}
        </span>
      </button>
      {repoPath ? <button type="button" aria-label="Add file to Quick docs" title="Pin a file" aria-haspopup="dialog" aria-expanded={Boolean(pickerAnchor)} onClick={event => { setExpanded(true); setPickerAnchor(event.currentTarget.getBoundingClientRect()); }} onMouseEnter={event => { event.currentTarget.style.background = 'var(--t-hover)'; }} onMouseLeave={event => { event.currentTarget.style.background = 'transparent'; }} style={{ width: 24, height: 24, marginRight: 8, border: 0, borderRadius: 5, padding: 0, background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer' }}><svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 5v14M5 12h14" /></svg></button> : null}
      </div>
      <div hidden={!expanded} style={{ maxHeight: 220, overflowY: 'auto', scrollbarWidth: 'none', overscrollBehavior: 'contain' }}>
      {expanded && groups.map((group) => (
        <div key={group.label} style={{ paddingBottom: 6 }}>
          <div style={{ height: 24, display: 'flex', alignItems: 'center', paddingTop: 0, paddingRight: 10, paddingBottom: 0, paddingLeft: 10, color: 'var(--t-text-faint)', fontFamily: UI_FONT, fontSize: 11, fontWeight: 400, letterSpacing: 0 }}>
            {group.label}
          </div>
          {group.entries.map((entry) => {
            const selected = selectedFile === entry.path;
            const displayPath = displayPathForEntry(entry.path, repoPath);
            return (
              <button
                key={entry.path}
                type="button"
                onClick={() => onSelectFile(entry.path)}
                title={displayPath}
                style={{
                  minHeight: 36,
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  border: 'none',
                  borderRadius: 0,
                  background: selected ? 'var(--t-input-bg)' : 'transparent',
                  color: selected ? 'var(--t-text)' : 'var(--t-text-secondary)',
                  cursor: 'pointer',
                  fontFamily: UI_FONT,
                  paddingTop: 4,
                  paddingRight: 8,
                  paddingBottom: 4,
                  paddingLeft: 10,
                  textAlign: 'left',
                }}
                onMouseEnter={(event) => { if (!selected) event.currentTarget.style.background = 'var(--t-hover)'; }}
                onMouseLeave={(event) => { if (!selected) event.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ color: selected ? 'var(--t-text)' : 'var(--t-text-muted)', fontSize: 12, fontWeight: 300, letterSpacing: 0, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.label}
                  </span>
                  <span style={{ color: 'var(--t-text-faint)', fontFamily: MONO_FONT, fontSize: 10, fontWeight: 500, letterSpacing: 0, lineHeight: 1.15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.value}
                  </span>
                </span>
                <ChevronIcon />
              </button>
            );
          })}
        </div>
      ))}
      {expanded && pins.paths.length ? <div style={{ paddingBottom: 5 }}>
        <div style={{ paddingLeft: 12, paddingTop: 5, paddingBottom: 5, color: 'var(--t-text-faint)', fontFamily: UI_FONT, fontSize: 11 }}>Pinned files</div>
        {pins.paths.map(path => <div key={path} style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 6, marginRight: 6, borderRadius: 5, background: selectedFile === path ? 'var(--t-input-bg)' : 'transparent' }}>
          <button type="button" title={path} onClick={() => onSelectFile(path)} onMouseEnter={event => { event.currentTarget.style.background = 'var(--t-hover)'; }} onMouseLeave={event => { event.currentTarget.style.background = 'transparent'; }} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 7, height: 26, border: 0, borderRadius: 5, paddingLeft: 6, paddingRight: 4, background: 'transparent', color: 'var(--t-text-secondary)', fontFamily: UI_FONT, fontSize: 12, fontWeight: 300, cursor: 'pointer', textAlign: 'left' }}><FileTypeIcon name={path} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path.split('/').pop()}</span></button>
          <button type="button" aria-label={`Unpin ${path}`} title="Unpin file" onClick={() => pins.unpin(path)} style={{ width: 24, height: 24, padding: 0, border: 0, borderRadius: 5, background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer' }}><svg aria-hidden width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
        </div>)}
      </div> : null}
      {expanded && !total ? <div style={{ padding: 10, color: 'var(--t-text-faint)', fontFamily: UI_FONT, fontSize: 11 }}>Pin files you reach for often.</div> : null}
      </div>
      {pickerAnchor && repoPath ? <QuickDocFilePicker key={repoPath} repoPath={repoPath} selectedFile={selectedFile} pinned={pins.paths} anchor={pickerAnchor} onPin={pins.pin} onClose={() => setPickerAnchor(null)} /> : null}
    </div>
  );
}
