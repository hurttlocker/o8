'use client';

import type { CSSProperties } from 'react';

import { ComparisonColumn } from './ComparisonColumn';
import type { ComparisonGroup } from './useComparisonGroups';

/**
 * The N-up "pick the winner" surface (item 3): every best-of-N candidate's diff,
 * side by side, each read from its own isolated worktree. Both the competing platform and o8 market
 * "compare & merge the winner"; neither shipped the N-up matrix — this is it. The
 * gated pick (winner → review-gate merge, losers → archive) lands in a later stage;
 * here the operator can see all candidates at once.
 *
 * Layout: a horizontal row of fixed-width columns that scrolls past the panel
 * width (2 fit at the auto-widened ~960px, 3+ scroll) — width honesty over cramming.
 */
export function ComparisonMatrix({ group }: { group: ComparisonGroup }) {
  const containerStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
  };

  const headerStyle: CSSProperties = {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    paddingTop: 10,
    paddingRight: 12,
    paddingBottom: 10,
    paddingLeft: 12,
    borderBottom: '1px solid var(--t-divider-subtle)',
  };

  const rowStyle: CSSProperties = {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'row',
    overflowX: 'auto',
    overflowY: 'hidden',
  };

  return (
    <div style={containerStyle} data-comparison-matrix={group.groupId}>
      <div style={headerStyle}>
        <span style={{ fontSize: 13, fontWeight: 500, letterSpacing: '-0.2px', color: 'var(--t-text)' }}>
          Compare candidates
        </span>
        <span style={{ fontSize: 10.5, fontWeight: 260, letterSpacing: '-0.2px', color: 'var(--t-text-muted)' }}>
          {group.candidates.length} sealed worktrees · pick the winner
        </span>
      </div>
      <div style={rowStyle}>
        {group.candidates.map((candidate, index) => (
          <ComparisonColumn key={candidate.packet.id} candidate={candidate} index={index} />
        ))}
      </div>
    </div>
  );
}
