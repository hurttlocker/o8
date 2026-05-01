'use client';
/* eslint-disable react-hooks/set-state-in-effect -- file selection changes intentionally reset and refetch pane state */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { diffLineTone, splitUnifiedDiff, type DiffLine } from './diff-render';

type DiffMode = 'unified' | 'side';
type O8DiffPaneProps = { repoPath?: string | null; selectedFile: string | null };
type FileDiffResponse = { diff?: string; stagedDiff?: string; error?: string };
const UI_FONT = '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif';
const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

function ModeButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: '1px solid var(--t-divider-subtle)',
        borderRadius: 10,
        background: active ? 'var(--t-input-bg)' : 'transparent',
        color: active ? 'var(--t-text)' : 'var(--t-text-muted)',
        cursor: 'pointer',
        fontFamily: UI_FONT,
        fontSize: 11,
        fontWeight: 600,
        minHeight: 28,
        paddingTop: 0,
        paddingRight: 10,
        paddingBottom: 0,
        paddingLeft: 10,
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--t-hover)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      {label}
    </button>
  );
}
function lineStyle(line: DiffLine | null): CSSProperties {
  const tone = diffLineTone(line?.kind ?? 'context');
  return {
    minHeight: 18,
    lineHeight: '18px',
    background: line ? tone.background : 'transparent',
    color: line ? tone.color : 'var(--t-text-faint)',
    fontFamily: MONO_FONT,
    fontSize: 11,
    whiteSpace: 'pre',
    tabSize: 2,
  };
}
function UnifiedRows({ lines }: { lines: DiffLine[] }) {
  return (
    <div style={{ minWidth: 'max-content' }}>
      {lines.map((line, index) => {
        const tone = diffLineTone(line.kind);
        return (
          <div
            key={`${index}:${line.text}`}
            style={{
              display: 'grid',
              gridTemplateColumns: '70px minmax(520px, 1fr)',
              minHeight: 18,
              background: tone.background,
            }}
          >
            <span
              style={{
                color: 'var(--t-text-faint)',
                fontFamily: MONO_FONT,
                fontSize: 10,
                lineHeight: '18px',
                paddingRight: 10,
                textAlign: 'right',
                userSelect: 'none',
              }}
            >
              {line.oldNumber ?? line.newNumber ?? ''}
            </span>
            <span style={{ ...lineStyle(line), background: 'transparent' }}>{line.text || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}
function sideRows(lines: DiffLine[]) {
  const rows: Array<{ left: DiffLine | null; right: DiffLine | null }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line?.kind !== 'del') {
      rows.push(line?.kind === 'add' ? { left: null, right: line } : { left: line ?? null, right: line ?? null });
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (lines[index]?.kind === 'del') {
      dels.push(lines[index]!);
      index += 1;
    }
    while (lines[index]?.kind === 'add') {
      adds.push(lines[index]!);
      index += 1;
    }
    index -= 1;
    const count = Math.max(dels.length, adds.length);
    for (let offset = 0; offset < count; offset += 1) {
      rows.push({ left: dels[offset] ?? null, right: adds[offset] ?? null });
    }
  }
  return rows;
}
function SideRows({ lines }: { lines: DiffLine[] }) {
  const rows = useMemo(() => sideRows(lines), [lines]);
  return (
    <div style={{ minWidth: 900 }}>
      {rows.map((row, index) => (
        <div
          key={`${index}:${row.left?.text ?? ''}:${row.right?.text ?? ''}`}
          style={{
            display: 'grid',
            gridTemplateColumns: '46px minmax(360px, 1fr) 46px minmax(360px, 1fr)',
            minHeight: 18,
          }}
        >
          <span style={{ ...lineStyle(row.left), color: 'var(--t-text-faint)', paddingRight: 8, textAlign: 'right', userSelect: 'none' }}>{row.left?.oldNumber ?? ''}</span>
          <span style={lineStyle(row.left)}>{row.left?.text || ' '}</span>
          <span style={{ ...lineStyle(row.right), color: 'var(--t-text-faint)', paddingRight: 8, textAlign: 'right', userSelect: 'none' }}>{row.right?.newNumber ?? ''}</span>
          <span style={lineStyle(row.right)}>{row.right?.text || ' '}</span>
        </div>
      ))}
    </div>
  );
}

export function O8DiffPane({ repoPath, selectedFile }: O8DiffPaneProps) {
  const [mode, setMode] = useState<DiffMode>('unified');
  const [diff, setDiff] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lines = useMemo(() => splitUnifiedDiff(diff), [diff]);

  useEffect(() => {
    if (!selectedFile) {
      setDiff('');
      setError(null);
      setLoading(false);
      return;
    }
    if (!repoPath) {
      setDiff('');
      setError('Select a repo before loading a file diff.');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ path: selectedFile, workspace: repoPath });
    fetch(`/api/panel/file-diff?${params.toString()}`)
      .then((res) => res.json() as Promise<FileDiffResponse>)
      .then((data) => {
        if (cancelled) return;
        if (data.error) setError(data.error);
        setDiff(data.diff ?? data.stagedDiff ?? '');
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [repoPath, selectedFile]);

  return (
    <div style={{ display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0, background: 'var(--t-canvas-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 42, paddingLeft: 12, paddingRight: 12, borderBottom: '1px solid var(--t-divider-subtle)', fontFamily: UI_FONT }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 600 }}>
          {selectedFile ? `[DIFF] · ${selectedFile}` : '[DIFF] · select a file from Files tab or focus drawer'}
        </span>
        <ModeButton active={mode === 'unified'} label="Unified" onClick={() => setMode('unified')} />
        <ModeButton active={mode === 'side'} label="Side-by-side" onClick={() => setMode('side')} />
      </div>
      {!selectedFile ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t-text-muted)', fontFamily: MONO_FONT, fontSize: 12 }}>
          [DIFF] · select a file from Files tab or focus drawer
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflowX: 'auto', overflowY: 'auto', paddingTop: 10, paddingBottom: 10 }}>
          {loading ? <div style={{ paddingLeft: 14, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12 }}>Loading diff...</div> : null}
          {!loading && error ? <div style={{ paddingLeft: 14, color: 'var(--t-brand-red)', fontFamily: UI_FONT, fontSize: 12 }}>{error}</div> : null}
          {!loading && !error && !diff ? <div style={{ paddingLeft: 14, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12 }}>No diff available for this file.</div> : null}
          {!loading && !error && diff ? (mode === 'unified' ? <UnifiedRows lines={lines} /> : <SideRows lines={lines} />) : null}
        </div>
      )}
    </div>
  );
}
