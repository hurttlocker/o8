'use client';
/* eslint-disable react-hooks/set-state-in-effect -- the async per-file diff fetch intentionally toggles loading/error/diff state */

import { memo, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from '../lucide-shims';
import { splitUnifiedDiff, diffLineTone, type DiffLine } from '../o8-panel/diff-render';
import { useWorkspaceChanges } from '../o8-panel/workspace-rail/ChangesList';
import type { ReviewChangedFile } from '@/lib/fleet/types';

/**
 * ReviewPanel — the dedicated Review surface for the right panel's `review`
 * mode. Codex-style: one continuous diff, no file-list rail. Every changed
 * file is a collapsible row whose diff loads inline on expand.
 *
 * Phase 1: continuous diff.  Phase 2: Codex-style header — file filter +
 * unified/split diff toggle.  Phase 3: chat-file clicks → header tabs.
 * (A scope dropdown — Last turn / Staged — needs backend data wiring and is
 * tracked as its own follow-up, not part of this header.)
 */

type DiffMode = 'unified' | 'side';

const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace";

// ── icons (raw SVG — React icon components don't render in the Tauri webview) ──

function IconSearch({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function IconSplit({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
    </svg>
  );
}

function IconUnified({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function statusAccent(status: ReviewChangedFile['status']): string {
  if (status === 'added' || status === 'untracked') return 'var(--t-terminal-ansi-bright-green, #22c55e)';
  if (status === 'deleted') return 'var(--t-brand-red, #ef4444)';
  if (status === 'renamed') return 'var(--t-brand-orange, #f97316)';
  return 'var(--t-accent, #2563eb)';
}

function DiffStatBadge({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: MONO_FONT, fontSize: 11, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
      {additions > 0 ? <span style={{ color: 'var(--t-terminal-ansi-bright-green, #16a34a)' }}>+{additions}</span> : null}
      {deletions > 0 ? <span style={{ color: 'var(--t-terminal-ansi-bright-red, #ef4444)' }}>-{deletions}</span> : null}
      {additions === 0 && deletions === 0 ? <span style={{ color: 'var(--t-text-faint)' }}>0</span> : null}
    </span>
  );
}

// ── diff rendering ──

const NUM_CELL: CSSProperties = {
  display: 'inline-block',
  width: 32,
  color: 'var(--t-text-faint)',
  textAlign: 'right',
  flexShrink: 0,
  fontVariantNumeric: 'tabular-nums',
  userSelect: 'none',
};

function UnifiedDiff({ lines }: { lines: DiffLine[] }) {
  return (
    <div style={{ fontFamily: MONO_FONT, fontSize: 11, lineHeight: 1.55, background: 'var(--t-bg-card)', borderTop: '1px solid var(--t-divider-subtle)' }}>
      {lines.map((line, index) => {
        const tone = diffLineTone(line.kind);
        return (
          <div
            key={index}
            style={{ display: 'flex', alignItems: 'flex-start', gap: 8, paddingTop: 1, paddingBottom: 1, paddingLeft: 12, paddingRight: 12, background: tone.background, color: tone.color, whiteSpace: 'pre' }}
          >
            <span style={NUM_CELL}>{line.oldNumber ?? ''}</span>
            <span style={NUM_CELL}>{line.newNumber ?? ''}</span>
            <span style={{ flex: 1, minWidth: 0 }}>{line.text || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Pair deletions with additions into left/right rows for the split view. */
function sideRows(lines: DiffLine[]): Array<{ left: DiffLine | null; right: DiffLine | null }> {
  const rows: Array<{ left: DiffLine | null; right: DiffLine | null }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line?.kind !== 'del') {
      rows.push(line?.kind === 'add' ? { left: null, right: line } : { left: line ?? null, right: line ?? null });
      continue;
    }
    const deletions: DiffLine[] = [];
    const additions: DiffLine[] = [];
    while (lines[index]?.kind === 'del') { deletions.push(lines[index]!); index += 1; }
    while (lines[index]?.kind === 'add') { additions.push(lines[index]!); index += 1; }
    index -= 1;
    const count = Math.max(deletions.length, additions.length);
    for (let offset = 0; offset < count; offset += 1) {
      rows.push({ left: deletions[offset] ?? null, right: additions[offset] ?? null });
    }
  }
  return rows;
}

function SideDiff({ lines }: { lines: DiffLine[] }) {
  const rows = useMemo(() => sideRows(lines), [lines]);
  return (
    <div className="cortex-themed-scroll" style={{ background: 'var(--t-bg-card)', borderTop: '1px solid var(--t-divider-subtle)', overflowX: 'auto' }}>
      <div style={{ minWidth: 680, fontFamily: MONO_FONT, fontSize: 11, lineHeight: 1.55 }}>
        {rows.map((row, index) => {
          const leftTone = diffLineTone(row.left?.kind ?? 'context');
          const rightTone = diffLineTone(row.right?.kind ?? 'context');
          return (
            <div key={index} style={{ display: 'grid', gridTemplateColumns: '30px minmax(0, 1fr) 30px minmax(0, 1fr)' }}>
              <span style={{ ...NUM_CELL, width: 'auto', paddingRight: 6 }}>{row.left?.oldNumber ?? ''}</span>
              <span style={{ whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: 8, background: row.left ? leftTone.background : 'transparent', color: row.left ? leftTone.color : 'var(--t-text-faint)' }}>{row.left?.text || ' '}</span>
              <span style={{ ...NUM_CELL, width: 'auto', paddingRight: 6 }}>{row.right?.newNumber ?? ''}</span>
              <span style={{ whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: 8, background: row.right ? rightTone.background : 'transparent', color: row.right ? rightTone.color : 'var(--t-text-faint)' }}>{row.right?.text || ' '}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DiffPatch({ patch, mode }: { patch: string; mode: DiffMode }) {
  const lines = useMemo(() => splitUnifiedDiff(patch), [patch]);
  return mode === 'side' ? <SideDiff lines={lines} /> : <UnifiedDiff lines={lines} />;
}

function RowMessage({ text, tone }: { text: string; tone?: 'error' }) {
  return (
    <div style={{ paddingTop: 8, paddingBottom: 12, paddingLeft: 14, paddingRight: 14, fontFamily: UI_FONT, fontSize: 11, color: tone === 'error' ? 'var(--t-brand-red)' : 'var(--t-text-muted)', background: 'var(--t-bg-card)', borderTop: '1px solid var(--t-divider-subtle)' }}>
      {text}
    </div>
  );
}

function PanelMessage({ text, tone }: { text: string; tone?: 'error' }) {
  return (
    <div style={{ paddingTop: 18, paddingRight: 16, paddingBottom: 18, paddingLeft: 16, fontFamily: UI_FONT, fontSize: 12, color: tone === 'error' ? 'var(--t-brand-red)' : 'var(--t-text-muted)' }}>
      {text}
    </div>
  );
}

/** One changed file: a collapsible header + an inline diff loaded on expand. */
const ReviewFileRow = memo(function ReviewFileRow({ file, repoPath, mode }: { file: ReviewChangedFile; repoPath: string; mode: DiffMode }) {
  const [open, setOpen] = useState(true);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setDiff(null);
    const params = new URLSearchParams({ path: file.path, workspace: repoPath });
    fetch(`/api/panel/file-diff?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as { diff?: string; stagedDiff?: string; error?: string };
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
          setError(err instanceof Error ? err.message : 'Unable to load diff.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, file.path, repoPath]);

  const accent = statusAccent(file.status);

  return (
    <div style={{ borderBottom: '1px solid var(--t-divider-subtle)' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={file.path}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 14, background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
      >
        <span style={{ color: 'var(--t-text-faint)', display: 'inline-flex', flexShrink: 0 }}>
          {open ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} />}
        </span>
        <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: accent, flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, fontFamily: MONO_FONT, fontSize: 12, color: 'var(--t-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>
          {file.path}
        </span>
        <DiffStatBadge additions={file.additions ?? 0} deletions={file.deletions ?? 0} />
      </button>
      {open ? (
        loading ? (
          <RowMessage text="Loading diff…" />
        ) : error ? (
          <RowMessage text={error} tone="error" />
        ) : diff && diff.trim() ? (
          <DiffPatch patch={diff} mode={mode} />
        ) : (
          <RowMessage text="No diff available (binary file or too large)." />
        )
      ) : null}
    </div>
  );
});

// ── header toolbar ──

function ToolbarButton({ active, title, onClick, children }: { active?: boolean; title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        padding: 0,
        border: 'none',
        borderRadius: 8,
        background: active ? 'var(--t-input-bg)' : 'transparent',
        color: active ? 'var(--t-text)' : 'var(--t-text-muted)',
        cursor: 'pointer',
        flexShrink: 0,
      }}
      onMouseEnter={(event) => { if (!active) event.currentTarget.style.background = 'var(--t-hover)'; }}
      onMouseLeave={(event) => { if (!active) event.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}

export const ReviewPanel = memo(function ReviewPanel({ repoPath }: { repoPath?: string | null }) {
  const changes = useWorkspaceChanges(repoPath);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<DiffMode>('unified');

  const trimmed = query.trim().toLowerCase();
  const visible = useMemo(
    () => (trimmed ? changes.files.filter((file) => file.path.toLowerCase().includes(trimmed)) : changes.files),
    [changes.files, trimmed],
  );
  const hasFiles = changes.files.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--t-bg)' }}>
      {hasFiles ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 40, paddingTop: 6, paddingBottom: 6, paddingLeft: 14, paddingRight: 10, borderBottom: '1px solid var(--t-divider-subtle)', flexShrink: 0 }}>
          <span style={{ fontFamily: UI_FONT, fontSize: 12, fontWeight: 650, color: 'var(--t-text)', flexShrink: 0 }}>
            {trimmed ? `${visible.length} of ${changes.files.length}` : `${changes.files.length} ${changes.files.length === 1 ? 'file' : 'files'} changed`}
          </span>
          <DiffStatBadge additions={changes.totalAdditions} deletions={changes.totalDeletions} />
          <div style={{ flex: 1, minWidth: 8 }} />
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 28,
              paddingLeft: 8,
              paddingRight: 8,
              borderRadius: 8,
              border: '1px solid var(--t-input-border)',
              background: 'var(--t-input-bg)',
              color: 'var(--t-text-muted)',
              flexShrink: 1,
              minWidth: 0,
            }}
          >
            <IconSearch size={12} />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter files"
              spellCheck={false}
              style={{
                border: 'none',
                outline: 'none',
                background: 'transparent',
                color: 'var(--t-text)',
                fontFamily: UI_FONT,
                fontSize: 11.5,
                width: 116,
                minWidth: 0,
                padding: 0,
              }}
            />
          </div>
          <ToolbarButton
            title={mode === 'unified' ? 'Switch to split diff' : 'Switch to unified diff'}
            active={mode === 'side'}
            onClick={() => setMode((current) => (current === 'unified' ? 'side' : 'unified'))}
          >
            {mode === 'unified' ? <IconSplit size={14} /> : <IconUnified size={14} />}
          </ToolbarButton>
        </div>
      ) : null}
      <div className="cortex-scroll-fade-y cortex-themed-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
        {!repoPath ? (
          <PanelMessage text="Select a repo to review changes." />
        ) : changes.loading && !hasFiles ? (
          <PanelMessage text="Loading changes…" />
        ) : changes.error ? (
          <PanelMessage text={changes.error} tone="error" />
        ) : !hasFiles ? (
          <PanelMessage text="Working tree clean — nothing to review." />
        ) : visible.length === 0 ? (
          <PanelMessage text={`No files match "${query.trim()}".`} />
        ) : (
          visible.map((file) => (
            <ReviewFileRow key={file.path} file={file} repoPath={repoPath} mode={mode} />
          ))
        )}
      </div>
    </div>
  );
});
