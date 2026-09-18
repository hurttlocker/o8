'use client';

import { useEffect, useState } from 'react';

import type { ClaimUnbacked, UnbackedClaimKind } from '@/lib/lane/report-claim-check';

/**
 * Advisory row on the packet card (#2447): the worker's final report claimed
 * something the diff or the recorded output did not show. Same geometry as
 * the referee row on the approval card (#2435). Nothing here feeds a decision.
 */

const MONO_FONT = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)';

const CLAIM_LABELS: Record<UnbackedClaimKind, string> = {
  tests: 'tests',
  files: 'files not in the diff',
};

export function claimUnbackedLabel(claim: Pick<ClaimUnbacked, 'claims'>): string {
  return `Report claim not backed: ${claim.claims.map((kind) => CLAIM_LABELS[kind] ?? kind).join(', ')}`;
}

export function PacketClaimUnbackedRowView({ claim }: { claim: ClaimUnbacked }) {
  return (
    <div
      data-o8-claim-unbacked-row=""
      style={{ display: 'grid', gridTemplateColumns: '68px minmax(0, 1fr)', gap: 8, alignItems: 'baseline', marginBottom: 7 }}
    >
      <span style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t-text-faint)' }}>
        Referee
      </span>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          minWidth: 0,
          paddingTop: 6,
          paddingRight: 8,
          paddingBottom: 6,
          paddingLeft: 8,
          borderRadius: 6,
          border: '1px solid var(--t-divider-subtle)',
          background: 'var(--t-input-bg)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', marginBottom: 2 }}>
          <span style={{ fontSize: 9, fontWeight: 400, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t-text-faint)' }}>
            Advisory
          </span>
          <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '-0.2px', color: 'var(--t-text-faint)' }}>
            Not used by the packet outcome
          </span>
        </div>
        <span style={{ fontSize: 10.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text-muted)', overflowWrap: 'anywhere' }}>
          {claimUnbackedLabel(claim)}
          {claim.verificationOutputPresent ? null : <span style={{ color: 'var(--t-text-faint)' }}> (no command output recorded)</span>}
        </span>
        {claim.receiptId ? (
          <span style={{ fontFamily: MONO_FONT, fontSize: 9.5, fontWeight: 300, letterSpacing: '-0.2px', color: 'var(--t-text-faint)', overflowWrap: 'anywhere' }}>
            {claim.receiptId}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Fetches the lane's latest unbacked-claim event; renders nothing when there is none. */
export function PacketClaimUnbackedRow({ laneId }: { laneId: string | null | undefined }) {
  const [claim, setClaim] = useState<ClaimUnbacked | null>(null);
  useEffect(() => {
    if (!laneId) return;
    let cancelled = false;
    void fetch(`/api/orchestrator/claim-unbacked?laneId=${encodeURIComponent(laneId)}`)
      .then(async (response) => (response.ok ? (await response.json()) as { result?: { claim?: ClaimUnbacked | null } } : null))
      .then((body) => { if (!cancelled) setClaim(body?.result?.claim ?? null); })
      .catch(() => { if (!cancelled) setClaim(null); });
    return () => { cancelled = true; };
  }, [laneId]);
  if (!laneId || !claim || claim.claims.length === 0) return null;
  return (
    <div style={{ paddingTop: 4, paddingRight: 10, paddingLeft: 10 }}>
      <PacketClaimUnbackedRowView claim={claim} />
    </div>
  );
}
