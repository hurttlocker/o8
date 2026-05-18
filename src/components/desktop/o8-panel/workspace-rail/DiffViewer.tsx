'use client';
/* eslint-disable react-hooks/set-state-in-effect -- selected file changes intentionally reset and refetch diff state */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { diffLineTone, splitUnifiedDiff, type DiffLine } from '../diff-render';

export type DiffDisplayMode = 'unified' | 'side';

type FileDiffResponse = { diff?: string; stagedDiff?: string; error?: string };

const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

function formatLoadError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/load failed|failed to fetch|networkerror/i.test(message)) {
    return 'Unable to reach the local diff service. Reselect the file or refresh the app.';
  }
  return message || 'Unable to load diff.';
}

function lineStyle(line: DiffLine | null, options?: { wrap?: boolean }): CSSProperties {
  const tone = diffLineTone(line?.kind ?? 'context');
  return {
    minHeight: 18,
    lineHeight: '18px',
    background: line ? tone.background : 'transparent',
    color: line ? tone.color : 'var(--t-text-faint)',
    fontFamily: MONO_FONT,
    fontSize: 11,
    whiteSpace: options?.wrap ? 'pre-wrap' : 'pre',
    overflowWrap: options?.wrap ? 'anywhere' : undefined,
    wordBreak: options?.wrap ? 'break-word' : undefined,
    tabSize: 2,
  };
}

function UnifiedRows({ lines }: { lines: DiffLine[] }) {
  return (
    <div style={{ width: '100%', minWidth: 0 }}>
      {lines.map((line, index) => {
        const tone = diffLineTone(line.kind);
        return (
          <div
            key={`${index}:${line.text}`}
            style={{
              display: 'grid',
              gridTemplateColumns: '52px minmax(0, 1fr)',
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
            <span style={{ ...lineStyle(line, { wrap: true }), background: 'transparent', paddingRight: 12 }}>{line.text || ' '}</span>
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

    const deletions: DiffLine[] = [];
    const additions: DiffLine[] = [];
    while (lines[index]?.kind === 'del') {
      deletions.push(lines[index]!);
      index += 1;
    }
    while (lines[index]?.kind === 'add') {
      additions.push(lines[index]!);
      index += 1;
    }
    index -= 1;

    const count = Math.max(deletions.length, additions.length);
    for (let offset = 0; offset < count; offset += 1) {
      rows.push({ left: deletions[offset] ?? null, right: additions[offset] ?? null });
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

export function DiffViewer({
  repoPath,
  selectedFile,
  mode,
}: {
  repoPath?: string | null;
  selectedFile: string | null;
  mode: DiffDisplayMode;
}) {
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
      setLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ path: selectedFile, workspace: repoPath });
    fetch(`/api/panel/file-diff?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as FileDiffResponse;
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        if (data.error) setError(data.error);
        setDiff(data.diff ?? data.stagedDiff ?? '');
      })
      .catch((err) => {
        if (!cancelled && (err as { name?: string })?.name !== 'AbortError') {
          setError(formatLoadError(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [repoPath, selectedFile]);

  if (!selectedFile) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t-text-muted)', fontFamily: MONO_FONT, fontSize: 12 }}>
        Select a file to inspect.
      </div>
    );
  }

  return (
    <div className="cortex-scroll-fade-y cortex-themed-scroll" style={{ flex: 1, minHeight: 0, overflowX: 'auto', overflowY: 'auto', paddingTop: 10, paddingBottom: 10, paddingRight: mode === 'unified' ? 8 : 0 }}>
      {loading ? <div style={{ paddingLeft: 14, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12 }}>Loading diff...</div> : null}
      {!loading && error ? <div style={{ paddingLeft: 14, color: 'var(--t-brand-red)', fontFamily: UI_FONT, fontSize: 12 }}>{error}</div> : null}
      {!loading && !error && !diff ? <div style={{ paddingLeft: 14, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12 }}>No diff available for this file.</div> : null}
      {!loading && !error && diff ? (mode === 'unified' ? <UnifiedRows lines={lines} /> : <SideRows lines={lines} />) : null}
    </div>
  );
}
