/**
 * #742 — Shared types + style primitives for the Context Recall Card rows.
 *
 * The rows mirror the Issues-style row pattern in PacketMetaRows.tsx
 * (uppercase label / value / chevron, click to expand). Hosted here so the
 * three row components — DirectiveRow, OutcomesRow, SymbolGraphRow — stay
 * consistent without re-declaring the same chrome.
 */

import {
  closeUnmergedDispositionLabel,
  isCloseUnmergedDisposition,
  type CloseUnmergedDisposition,
} from '@/lib/orchestrator/close-unmerged-shared';

export interface DirectiveSummary {
  id: string;
  title: string;
  scope: string;
  repoName: string | null;
  priority: number | null;
  body: string;
  /**
   * #769 — Last 3 merge-trailer lines surfaced under the directive title.
   * Newest-first, raw markdown line including the leading `- ` bullet, e.g.
   * `- 2026-04-29 [merged] feat(cortex): living specs (#769)`.
   * Empty array when the directive has not yet matched a merged packet, or
   * when `history: false` opts out.
   */
  recentMerges?: string[];
}

export interface RecentOutcome {
  id: string;
  outcome: 'succeeded' | 'failed' | 'partial' | 'interrupted' | CloseUnmergedDisposition;
  summary: string;
  runtime: string;
  branch: string | null;
  completedAt: string;
  reviewApproved: boolean | null;
  durationMs: number | null;
}

export type SymbolEdgeReasonView =
  | 'no-definition-recorded'
  | 'unknown-symbol'
  | 'trace-error';

export interface SymbolEdgeView {
  symbol: string;
  /** Indexer label (Function / Interface / Type / etc.) when known. */
  kind?: string | null;
  file?: string | null;
  line?: number | null;
  neighbours: string[];
  error?: string | null;
  /** Why `file`/`line` is unset, when it is. Phase 4 #739–#741. */
  reason?: SymbolEdgeReasonView | null;
}

export interface IndexEntry {
  repoId: string;
  repoName: string;
  localPath: string;
  status: string;
}

export interface IndexState {
  bootRan: boolean;
  inFlight: boolean;
  entries: IndexEntry[];
}

export const FONT_FAMILY = 'var(--font-sans-system)';
export const MONO_FAMILY = 'var(--font-mono, "SF Mono", Menlo, monospace)';

export const rowChromeStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 28,
  paddingTop: 5,
  paddingRight: 10,
  paddingBottom: 5,
  paddingLeft: 10,
  width: '100%',
  borderWidth: 0,
  background: 'transparent',
  textAlign: 'left' as const,
  cursor: 'pointer',
  transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
  fontFamily: FONT_FAMILY,
};

export const rowLabelStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--t-text-muted)',
  width: 84,
  flexShrink: 0,
};

export const rowValueStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 11.5,
  color: 'var(--t-text)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  letterSpacing: '-0.005em',
};

export const expandedSurfaceStyle: React.CSSProperties = {
  paddingTop: 4,
  paddingRight: 10,
  paddingBottom: 8,
  paddingLeft: 102,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  background: 'rgba(148, 163, 184, 0.04)',
};

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width={9}
      height={9}
      viewBox="0 0 10 10"
      fill="none"
      stroke="var(--t-text-faint)"
      strokeWidth="1.5"
      strokeLinecap="round"
      style={{
        flexShrink: 0,
        opacity: 0.55,
        transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
        transition: 'transform 150ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <path d="M2.5 3.5L5 6L7.5 3.5" />
    </svg>
  );
}

export function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 0) return 'just now';
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

export function outcomeTone(outcome: RecentOutcome['outcome'], reviewApproved: boolean | null) {
  if (outcome === 'succeeded' && reviewApproved !== false) {
    return { color: '#15803d', dot: '#22c55e', label: 'merged' };
  }
  if (outcome === 'succeeded' && reviewApproved === false) {
    return { color: '#b45309', dot: '#f59e0b', label: 'rejected' };
  }
  if (outcome === 'partial') return { color: '#b45309', dot: '#f59e0b', label: 'partial' };
  if (outcome === 'interrupted') return { color: 'var(--t-text-muted)', dot: 'var(--t-text-muted)', label: 'stopped' };
  if (isCloseUnmergedDisposition(outcome)) {
    return {
      color: 'var(--t-text-muted)',
      dot: 'var(--t-text-muted)',
      label: closeUnmergedDispositionLabel(outcome),
    };
  }
  return { color: '#b91c1c', dot: '#ef4444', label: 'failed' };
}

export function pickTopDirective(
  directives: DirectiveSummary[],
  repoName: string | null,
): DirectiveSummary | null {
  if (directives.length === 0) return null;
  if (repoName) {
    const scoped = directives.find(
      (d) => d.repoName && d.repoName.toLowerCase() === repoName.toLowerCase(),
    );
    if (scoped) return scoped;
  }
  return directives[0] ?? null;
}

export function indexEntryForRepo(state: IndexState | null, localPath: string | null): IndexEntry | null {
  if (!state || !localPath) return null;
  return state.entries.find((e) => e.localPath === localPath) ?? null;
}
