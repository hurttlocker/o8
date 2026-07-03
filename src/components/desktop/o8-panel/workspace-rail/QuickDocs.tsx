'use client';

import { useEffect, useMemo, useState } from 'react';

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
  const [groups, setGroups] = useState<QuickDocGroup[]>([]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (repoPath) params.set('workspace', repoPath);
    const query = params.toString();

    fetch(`/api/v2/files/quick-docs${query ? `?${query}` : ''}`)
      .then((response) => response.json() as Promise<QuickDocsResponse>)
      .then((data) => {
        if (!cancelled) setGroups(Array.isArray(data.groups) ? data.groups : []);
      })
      .catch(() => {
        if (!cancelled) setGroups([]);
      });

    return () => { cancelled = true; };
  }, [repoPath]);

  const total = useMemo(
    () => groups.reduce((sum, group) => sum + group.entries.length, 0),
    [groups],
  );

  if (total === 0) return null;

  return (
    <div style={{ borderBottom: '1px solid var(--t-divider-subtle)', background: 'var(--t-bg-card)' }}>
      <div style={{ minHeight: 32, display: 'flex', alignItems: 'center', gap: 8, paddingTop: 0, paddingRight: 10, paddingBottom: 0, paddingLeft: 10 }}>
        <span style={{ color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 10, fontWeight: 850, letterSpacing: 0, textTransform: 'uppercase' }}>
          Quick docs
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--t-text-faint)', fontFamily: MONO_FONT, fontSize: 10, fontWeight: 650 }}>
          {total}
        </span>
      </div>
      {groups.map((group) => (
        <div key={group.label} style={{ paddingBottom: 6 }}>
          <div style={{ height: 20, display: 'flex', alignItems: 'center', paddingTop: 0, paddingRight: 10, paddingBottom: 0, paddingLeft: 10, color: 'var(--t-text-faint)', fontFamily: UI_FONT, fontSize: 9, fontWeight: 800, letterSpacing: 0, textTransform: 'uppercase' }}>
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
                  minHeight: 44,
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
                  <span style={{ color: selected ? 'var(--t-text)' : 'var(--t-text-muted)', fontSize: 10, fontWeight: 850, letterSpacing: 0, lineHeight: 1.1, overflow: 'hidden', textOverflow: 'ellipsis', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                    {entry.label}
                  </span>
                  <span style={{ color: 'var(--t-text-faint)', fontFamily: MONO_FONT, fontSize: 10, fontWeight: 500, letterSpacing: 0, lineHeight: 1.15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.value}
                  </span>
                  <span style={{ color: 'var(--t-text-secondary)', fontFamily: MONO_FONT, fontSize: 9, fontWeight: 450, letterSpacing: 0, lineHeight: 1.1, opacity: 0.74, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {displayPath}
                  </span>
                </span>
                <ChevronIcon />
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
