'use client';

import { useCallback, useState } from 'react';
import type { CSSProperties } from 'react';

import { ComparisonColumn } from './ComparisonColumn';
import type { ComparisonGroup } from './useComparisonGroups';

/**
 * The N-up "pick the winner" surface (item 3): every best-of-N candidate's diff,
 * side by side, each read from its own isolated worktree. "Compare & merge the
 * winner" is widely marketed; the N-up matrix is the part nobody ships — this is
 * it. The gated pick (winner → review-gate merge, losers → archive) lands in a
 * later stage;
 * here the operator can see all candidates at once.
 *
 * Layout: a horizontal row of fixed-width columns that scrolls past the panel
 * width (2 fit at the auto-widened ~960px, 3+ scroll) — width honesty over cramming.
 */
export function ComparisonMatrix({ group }: { group: ComparisonGroup }) {
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  const handlePick = useCallback(async (packetId: string) => {
    setPickingId(packetId);
    setPickError(null);
    try {
      const response = await fetch('/api/orchestrator/comparison-pick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packetId }),
      });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: { message?: string } } | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error?.message ?? `Pick failed (${response.status}).`);
      }
      // Success — pickComparisonWinner recorded the approving review, archived the
      // losers, and merged the winner through the 5-layer gate. The group clears from
      // mission state on the next refresh, which empties this matrix; stay busy until then.
    } catch (error) {
      setPickError(error instanceof Error ? error.message : 'Pick failed.');
      setPickingId(null);
    }
  }, []);

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
      {pickError ? (
        <div
          role="alert"
          style={{
            flexShrink: 0,
            paddingTop: 8,
            paddingBottom: 8,
            paddingLeft: 12,
            paddingRight: 12,
            fontSize: 11,
            color: 'var(--t-danger, #f85149)',
            borderBottom: '1px solid var(--t-divider-subtle)',
          }}
        >
          {pickError}
        </div>
      ) : null}
      <div style={rowStyle}>
        {group.candidates.map((candidate, index) => (
          <ComparisonColumn
            key={candidate.packet.id}
            candidate={candidate}
            index={index}
            onPick={handlePick}
            picking={pickingId === candidate.packet.id}
            pickDisabled={pickingId !== null}
          />
        ))}
      </div>
    </div>
  );
}
