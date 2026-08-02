'use client';

import type { CSSProperties } from 'react';

import { ReviewFileRow } from '@/components/desktop/review/panel/ReviewFileRow';
import type { ComparisonCandidate } from './useComparisonGroups';
import { useComparisonDiff } from './useComparisonDiff';
import { useMergePreview } from './useMergePreview';

// Best-of-N candidates branch from the repo's default branch; the compare shows
// each candidate's committed diff vs this base (three-dot, merge-base relative).
const COMPARISON_BASE = 'main';

/**
 * One column of the N-up compare matrix — a single best-of-N candidate's diff,
 * read straight from its isolated worktree. Instances the SAME proven units the
 * single-worktree Review surface uses (`useWorkspaceChanges` + `ReviewFileRow`),
 * just parameterized by this candidate's `worktreePath`. The column stays read-only;
 * the matrix owns the gated selection action.
 */

// Stable signal objects — the matrix doesn't drive ReviewFileRow's keyboard-nav /
// bulk-collapse machinery (that's the single-column Review surface), so these are
// inert. Hoisted so they keep referential identity across renders.
const STABLE_COLLAPSE_SIGNAL: { open: boolean; nonce: number } = { open: false, nonce: 0 };
const STABLE_FOCUS_SIGNAL: { path: string | null; nonce: number } = { path: null, nonce: 0 };
const NOOP_ROW_REF = () => {};

// Preferred column width (flex basis). Columns GROW to fill the panel and SHRINK
// to the floor below, so 2 candidates always fit the panel (both pick buttons
// visible, no cut-off) while 3+ fall back to horizontal scroll. #1293.
const COLUMN_MIN_WIDTH = 440;
const COLUMN_FLOOR_WIDTH = 340;

export function ComparisonColumn({
  candidate,
  index,
  onPick,
  picking = false,
  pickDisabled = false,
}: {
  candidate: ComparisonCandidate;
  index: number;
  onPick?: (packetId: string) => void;
  picking?: boolean;
  pickDisabled?: boolean;
}) {
  const changes = useComparisonDiff(candidate.worktreePath, COMPARISON_BASE);
  // Dry-run the merge gate once the candidate is settled — the column shows its
  // verdict (passes / blocked-by) so the operator picks with the gate in view.
  const preview = useMergePreview(candidate.packet.id, candidate.complete);
  const { packet } = candidate;
  const model = packet.assignedModel || packet.runtime || `candidate ${index + 1}`;
  const roleLabel = packet.qualitySearch?.role === 'minimal_complete'
    ? 'smallest complete route'
    : packet.qualitySearch?.role === 'robustness_complete'
      ? 'robustness route'
      : null;
  const fileCount = changes.files.length;
  // Open diffs inline for small changesets, collapse dense ones (each row
  // lazy-fetches its diff on open, and a matrix multiplies that by N columns).
  const initialOpen = fileCount > 0 && fileCount <= 5;

  const columnStyle: CSSProperties = {
    flex: `1 1 ${COLUMN_MIN_WIDTH}px`,
    minWidth: COLUMN_FLOOR_WIDTH,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    borderRight: '1px solid var(--t-divider-subtle)',
  };

  const headerStyle: CSSProperties = {
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    paddingTop: 10,
    paddingRight: 12,
    paddingBottom: 10,
    paddingLeft: 12,
    borderBottom: '1px solid var(--t-divider-subtle)',
  };

  return (
    <div style={columnStyle} data-comparison-column={packet.id}>
      <div style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            aria-hidden
            style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--t-brand-orange, #FF5A1F)', flexShrink: 0 }}
          />
          <span
            title={model}
            style={{
              fontSize: 12.5,
              fontWeight: 500,
              letterSpacing: '-0.1px',
              color: 'var(--t-text)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {model}
          </span>
        </div>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 260,
            letterSpacing: '-0.3px',
            color: 'var(--t-text-muted)',
            fontFamily: '"SF Mono", ui-monospace, monospace',
          }}
        >
          {changes.loading && fileCount === 0
            ? 'loading…'
            : `${fileCount} file${fileCount === 1 ? '' : 's'} · +${changes.totalAdditions} −${changes.totalDeletions}`}
        </span>
        {roleLabel ? (
          <span style={{ fontSize: 10.5, fontWeight: 400, letterSpacing: '-0.2px', color: 'var(--t-text-muted)' }}>
            {roleLabel}
          </span>
        ) : null}
        {candidate.complete ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 1, minWidth: 0 }}>
            {preview.loading ? (
              <span style={{ fontSize: 10, fontWeight: 260, letterSpacing: '-0.2px', color: 'var(--t-text-faint)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                checking gate…
              </span>
            ) : preview.wouldMerge === true ? (
              <>
                <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--t-success, #3fb950)', flexShrink: 0 }} />
                <span style={{ fontSize: 10, fontWeight: 400, letterSpacing: '-0.2px', color: 'var(--t-success, #3fb950)' }}>Passes gate</span>
              </>
            ) : preview.wouldMerge === false ? (
              <>
                <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--t-warning, #d29922)', flexShrink: 0 }} />
                <span
                  title={preview.blockers.join(', ')}
                  style={{ fontSize: 10, fontWeight: 400, letterSpacing: '-0.2px', color: 'var(--t-warning, #d29922)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {preview.blockers.length ? `Blocked: ${preview.blockers.join(', ')}` : 'Blocked by gate'}
                </span>
              </>
            ) : (
              <span style={{ fontSize: 10, fontWeight: 260, letterSpacing: '-0.2px', color: 'var(--t-text-faint)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                gate unavailable
              </span>
            )}
          </div>
        ) : null}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
        {changes.error ? (
          <div style={{ paddingTop: 12, paddingBottom: 12, paddingLeft: 12, paddingRight: 12, fontSize: 11, color: 'var(--t-text-faint)' }}>
            {changes.error}
          </div>
        ) : fileCount === 0 ? (
          <div style={{ paddingTop: 12, paddingBottom: 12, paddingLeft: 12, paddingRight: 12, fontSize: 11, color: 'var(--t-text-faint)' }}>
            {changes.loading ? 'Reading changes…' : 'No changes in this worktree.'}
          </div>
        ) : (
          changes.files.map((file) => (
            <ReviewFileRow
              key={file.path}
              file={file}
              repoPath={candidate.worktreePath ?? ''}
              diffBase={COMPARISON_BASE}
              mode="unified"
              wrap={false}
              wordDiff={false}
              hideWhitespace={false}
              richPreview
              initialOpen={initialOpen}
              collapseSignal={STABLE_COLLAPSE_SIGNAL}
              focusSignal={STABLE_FOCUS_SIGNAL}
              selected={false}
              setRowRef={NOOP_ROW_REF}
            />
          ))
        )}
      </div>
      {onPick ? (
        <div style={{ flexShrink: 0, paddingTop: 8, paddingBottom: 8, paddingLeft: 10, paddingRight: 10, borderTop: '1px solid var(--t-divider-subtle)' }}>
          <button
            type="button"
            disabled={picking || pickDisabled || !candidate.complete}
            onClick={() => onPick(packet.id)}
            title={!candidate.complete ? 'Candidate still running' : 'Merge this candidate through the gate and archive the rest'}
            style={{
              width: '100%',
              height: 32,
              borderRadius: 8,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-brand-orange, #FF5A1F)',
              background: picking ? 'transparent' : 'rgba(255, 90, 31, 0.08)',
              color: 'var(--t-brand-orange, #FF5A1F)',
              fontSize: 12,
              fontWeight: 500,
              letterSpacing: '-0.1px',
              cursor: picking || pickDisabled || !candidate.complete ? 'default' : 'pointer',
              opacity: (pickDisabled && !picking) || !candidate.complete ? 0.45 : 1,
            }}
          >
            {picking ? 'Merging through gate…' : 'Pick this winner'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
