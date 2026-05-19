'use client';
/* eslint-disable react-hooks/set-state-in-effect -- the async per-file diff fetch intentionally toggles loading/error/diff state */

import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
/** Panel → row signal for bulk collapse/expand; rows re-apply `open` on each new identity. */
type CollapseSignal = { open: boolean; nonce: number };
type ReviewScope = 'all' | 'staged' | 'unstaged';
const SCOPE_LABELS: Record<ReviewScope, string> = { all: 'All changes', staged: 'Staged', unstaged: 'Unstaged' };
const SCOPE_ORDER: ReviewScope[] = ['all', 'staged', 'unstaged'];

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

function UnifiedDiff({ lines, wrap }: { lines: DiffLine[]; wrap: boolean }) {
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
            <span style={{ flex: 1, minWidth: 0, whiteSpace: wrap ? 'pre-wrap' : 'pre', overflowWrap: wrap ? 'anywhere' : 'normal' }}>{line.text || ' '}</span>
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

function SideDiff({ lines, wrap }: { lines: DiffLine[]; wrap: boolean }) {
  const rows = useMemo(() => sideRows(lines), [lines]);
  const textCell: CSSProperties = wrap
    ? { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', paddingRight: 8 }
    : { whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: 8 };
  return (
    <div className="cortex-themed-scroll" style={{ background: 'var(--t-bg-card)', borderTop: '1px solid var(--t-divider-subtle)', overflowX: 'auto' }}>
      <div style={{ minWidth: wrap ? 0 : 680, fontFamily: MONO_FONT, fontSize: 11, lineHeight: 1.55 }}>
        {rows.map((row, index) => {
          const leftTone = diffLineTone(row.left?.kind ?? 'context');
          const rightTone = diffLineTone(row.right?.kind ?? 'context');
          return (
            <div key={index} style={{ display: 'grid', gridTemplateColumns: '30px minmax(0, 1fr) 30px minmax(0, 1fr)' }}>
              <span style={{ ...NUM_CELL, width: 'auto', paddingRight: 6 }}>{row.left?.oldNumber ?? ''}</span>
              <span style={{ ...textCell, background: row.left ? leftTone.background : 'transparent', color: row.left ? leftTone.color : 'var(--t-text-faint)' }}>{row.left?.text || ' '}</span>
              <span style={{ ...NUM_CELL, width: 'auto', paddingRight: 6 }}>{row.right?.newNumber ?? ''}</span>
              <span style={{ ...textCell, background: row.right ? rightTone.background : 'transparent', color: row.right ? rightTone.color : 'var(--t-text-faint)' }}>{row.right?.text || ' '}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DiffPatch({ patch, mode, wrap }: { patch: string; mode: DiffMode; wrap: boolean }) {
  const lines = useMemo(() => splitUnifiedDiff(patch), [patch]);
  return mode === 'side' ? <SideDiff lines={lines} wrap={wrap} /> : <UnifiedDiff lines={lines} wrap={wrap} />;
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
const ReviewFileRow = memo(function ReviewFileRow({ file, repoPath, mode, wrap, collapseSignal }: { file: ReviewChangedFile; repoPath: string; mode: DiffMode; wrap: boolean; collapseSignal: CollapseSignal }) {
  const [open, setOpen] = useState(true);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Apply the panel-level bulk collapse/expand signal whenever it changes.
  useEffect(() => {
    setOpen(collapseSignal.open);
  }, [collapseSignal]);

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
          <DiffPatch patch={diff} mode={mode} wrap={wrap} />
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

function IconMore({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}

function IconCheck({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** One row of the `···` overflow menu. Toggle items pass `checked`; plain actions omit it. */
function MenuItem({ onClick, checked, children }: { onClick: () => void; checked?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        height: 30,
        paddingLeft: 9,
        paddingRight: 8,
        border: 'none',
        borderRadius: 7,
        background: 'transparent',
        color: 'var(--t-text)',
        fontFamily: UI_FONT,
        fontSize: 12,
        cursor: 'pointer',
        textAlign: 'left',
      }}
      onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {checked !== undefined ? (
        <span style={{ display: 'inline-flex', width: 14, justifyContent: 'center', color: checked ? 'var(--t-accent)' : 'transparent' }}>
          <IconCheck size={13} />
        </span>
      ) : null}
    </button>
  );
}

export const ReviewPanel = memo(function ReviewPanel({ repoPath }: { repoPath?: string | null }) {
  const changes = useWorkspaceChanges(repoPath);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<DiffMode>('unified');
  const [wrap, setWrap] = useState(false);
  const [collapseSignal, setCollapseSignal] = useState<CollapseSignal>({ open: true, nonce: 0 });
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [scope, setScope] = useState<ReviewScope>('all');
  const [scopeOpen, setScopeOpen] = useState(false);
  const scopeRef = useRef<HTMLDivElement | null>(null);

  // Close the header menus on outside-click or Escape.
  useEffect(() => {
    if (!menuOpen && !scopeOpen) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current && !menuRef.current.contains(target)) setMenuOpen(false);
      if (scopeRef.current && !scopeRef.current.contains(target)) setScopeOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        setScopeOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, scopeOpen]);

  const handleCollapseAll = () => {
    setCollapseSignal((signal) => ({ open: !signal.open, nonce: signal.nonce + 1 }));
    setMenuOpen(false);
  };
  const handleWordWrap = () => {
    setWrap((value) => !value);
    setMenuOpen(false);
  };
  const handleRefresh = () => {
    void changes.refresh();
    setMenuOpen(false);
  };
  const handleSelectScope = (next: ReviewScope) => {
    setScope(next);
    setScopeOpen(false);
  };

  const trimmed = query.trim().toLowerCase();
  const visible = useMemo(() => {
    let list = changes.files;
    if (scope === 'staged') list = list.filter((file) => file.staged);
    else if (scope === 'unstaged') list = list.filter((file) => file.unstaged);
    if (trimmed) list = list.filter((file) => file.path.toLowerCase().includes(trimmed));
    return list;
  }, [changes.files, trimmed, scope]);
  const visibleStats = useMemo(
    () => visible.reduce(
      (acc, file) => ({
        additions: acc.additions + (file.additions ?? 0),
        deletions: acc.deletions + (file.deletions ?? 0),
      }),
      { additions: 0, deletions: 0 },
    ),
    [visible],
  );
  const hasFiles = changes.files.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--t-bg)' }}>
      {hasFiles ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 40, paddingTop: 6, paddingBottom: 6, paddingLeft: 14, paddingRight: 10, borderBottom: '1px solid var(--t-divider-subtle)', flexShrink: 0 }}>
          <div ref={scopeRef} style={{ position: 'relative', flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setScopeOpen((open) => !open)}
              title="Change review scope"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                height: 28,
                paddingLeft: 9,
                paddingRight: 7,
                border: 'none',
                borderRadius: 8,
                background: scopeOpen ? 'var(--t-input-bg)' : 'transparent',
                color: 'var(--t-text)',
                fontFamily: UI_FONT,
                fontSize: 12,
                fontWeight: 650,
                cursor: 'pointer',
              }}
              onMouseEnter={(event) => { if (!scopeOpen) event.currentTarget.style.background = 'var(--t-hover)'; }}
              onMouseLeave={(event) => { if (!scopeOpen) event.currentTarget.style.background = 'transparent'; }}
            >
              {SCOPE_LABELS[scope]}
              <ChevronDown size={12} strokeWidth={2} />
            </button>
            {scopeOpen ? (
              <div
                role="menu"
                style={{
                  position: 'absolute',
                  top: 34,
                  left: 0,
                  minWidth: 156,
                  padding: 4,
                  borderRadius: 10,
                  background: 'var(--t-bg-card)',
                  border: '1px solid var(--t-divider)',
                  boxShadow: '0 10px 28px rgba(0, 0, 0, 0.22)',
                  zIndex: 50,
                }}
              >
                {SCOPE_ORDER.map((option) => (
                  <MenuItem key={option} checked={scope === option} onClick={() => handleSelectScope(option)}>
                    {SCOPE_LABELS[option]}
                  </MenuItem>
                ))}
              </div>
            ) : null}
          </div>
          <span style={{ fontFamily: UI_FONT, fontSize: 11.5, fontWeight: 500, color: 'var(--t-text-muted)', flexShrink: 0 }}>
            {scope !== 'all' || trimmed
              ? `${visible.length} of ${changes.files.length}`
              : `${changes.files.length} ${changes.files.length === 1 ? 'file' : 'files'}`}
          </span>
          <DiffStatBadge additions={visibleStats.additions} deletions={visibleStats.deletions} />
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
          <div ref={menuRef} style={{ position: 'relative', flexShrink: 0 }}>
            <ToolbarButton title="More" active={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
              <IconMore size={15} />
            </ToolbarButton>
            {menuOpen ? (
              <div
                role="menu"
                style={{
                  position: 'absolute',
                  top: 34,
                  right: 0,
                  minWidth: 168,
                  padding: 4,
                  borderRadius: 10,
                  background: 'var(--t-bg-card)',
                  border: '1px solid var(--t-divider)',
                  boxShadow: '0 10px 28px rgba(0, 0, 0, 0.22)',
                  zIndex: 50,
                }}
              >
                <MenuItem onClick={handleCollapseAll}>{collapseSignal.open ? 'Collapse all' : 'Expand all'}</MenuItem>
                <MenuItem onClick={handleWordWrap} checked={wrap}>Word wrap</MenuItem>
                <MenuItem onClick={handleRefresh}>Refresh</MenuItem>
              </div>
            ) : null}
          </div>
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
          <PanelMessage
            text={
              query.trim()
                ? `No files match "${query.trim()}".`
                : scope === 'staged'
                  ? 'No staged changes.'
                  : scope === 'unstaged'
                    ? 'No unstaged changes.'
                    : 'No files match.'
            }
          />
        ) : (
          visible.map((file) => (
            <ReviewFileRow key={file.path} file={file} repoPath={repoPath} mode={mode} wrap={wrap} collapseSignal={collapseSignal} />
          ))
        )}
      </div>
    </div>
  );
});
