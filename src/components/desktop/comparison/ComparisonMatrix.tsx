'use client';

import { useCallback, useState } from 'react';
import type { CSSProperties } from 'react';

import { ComparisonColumn } from './ComparisonColumn';
import type { ComparisonGroup } from './useComparisonGroups';

/**
 * The N-up "pick the winner" surface (item 3): every best-of-N candidate's diff,
 * side by side, each read from its own isolated worktree. "Compare & merge the
 * winner" is widely marketed; the N-up matrix is the part nobody ships — this is
 * it. The gated action either uses the operator's manual pick or, for bounded
 * quality search, filters and ranks candidates from their persisted evidence.
 *
 * Layout: a horizontal row of fixed-width columns that scrolls past the panel
 * width (2 fit at the auto-widened ~960px, 3+ scroll) — width honesty over cramming.
 */
export function ComparisonMatrix({ group }: { group: ComparisonGroup }) {
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const qualitySearch = group.candidates.length === 2
    && group.candidates.every((candidate) => candidate.packet.qualitySearch?.version === 1);

  const handlePick = useCallback(async (packetId: string) => {
    setPickingId(packetId);
    setPickError(null);
    try {
      const response = await fetch('/api/orchestrator/comparison-pick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packetId }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        result?: { merged?: boolean; note?: string; reason?: string };
        error?: { message?: string };
      } | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error?.message ?? `Pick failed (${response.status}).`);
      }
      if (payload.result?.merged === false) {
        if (payload.result.reason === 'quality_search_repair') {
          setPickingId(null);
          return;
        }
        throw new Error(payload.result.note ?? 'The selected candidate did not clear the merge gate.');
      }
      // Success — the comparison was resolved and the winner merged through the
      // gate. The group clears from mission state on the next refresh.
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
    justifyContent: 'space-between',
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 500, letterSpacing: '-0.2px', color: 'var(--t-text)' }}>
            {qualitySearch ? 'Quality search' : 'Compare candidates'}
          </span>
          <span style={{ fontSize: 10.5, fontWeight: 260, letterSpacing: '-0.2px', color: 'var(--t-text-muted)' }}>
            {qualitySearch
              ? 'sealed contract · evidence filter · lower blast radius wins complete ties'
              : `${group.candidates.length} sealed worktrees · pick the winner`}
          </span>
        </div>
        {qualitySearch ? (
          <button
            type="button"
            disabled={!group.ready || pickingId !== null}
            onClick={() => {
              const packetId = group.candidates[0]?.packet.id;
              if (packetId) void handlePick(packetId);
            }}
            title={group.ready ? 'Verify both candidates, select the evidence-backed winner, and merge it through the gate' : 'Candidates are still running'}
            style={{
              flexShrink: 0,
              height: 30,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 8,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-brand-orange, #FF5A1F)',
              background: pickingId ? 'transparent' : 'rgba(255, 90, 31, 0.08)',
              color: 'var(--t-brand-orange, #FF5A1F)',
              fontSize: 11,
              fontWeight: 500,
              cursor: !group.ready || pickingId ? 'default' : 'pointer',
              opacity: !group.ready ? 0.45 : 1,
            }}
          >
            {pickingId ? 'Verifying candidates…' : 'Verify, select & merge'}
          </button>
        ) : null}
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
            onPick={qualitySearch ? undefined : handlePick}
            picking={pickingId === candidate.packet.id}
            pickDisabled={pickingId !== null}
          />
        ))}
      </div>
    </div>
  );
}
