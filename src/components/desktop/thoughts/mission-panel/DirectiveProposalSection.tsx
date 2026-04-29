'use client';

/**
 * #746 — Section wrapper for the auto-directive proposer rows. Renders the
 * "Proposed directives" header + count badge + a stacked list of
 * `DirectiveProposalRow` components. Anchored above Open Issues in the
 * Mission panel because these rows are advice (system → operator), not
 * queued tasks.
 */

import type { DirectiveProposalCandidate } from '../directive-proposal-types';
import { DirectiveProposalRow } from '../DirectiveProposalRow';

interface DirectiveProposalSectionProps {
  proposals: DirectiveProposalCandidate[];
  pendingProposalId: string | null;
  onAccept: (proposal: DirectiveProposalCandidate) => void;
  onDismiss: (proposal: DirectiveProposalCandidate) => void;
}

export function DirectiveProposalSection({
  proposals,
  pendingProposalId,
  onAccept,
  onDismiss,
}: DirectiveProposalSectionProps) {
  if (proposals.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 4 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 28,
          paddingTop: 0,
          paddingRight: 8,
          paddingBottom: 0,
          paddingLeft: 8,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase' as const,
            letterSpacing: '0.05em',
            color: 'var(--t-text-muted)',
          }}
        >
          Proposed directives
        </span>
        <span
          title="Surfaced when the same fix-pattern appears 3+ times in the last 14 days"
          style={{
            paddingTop: 1,
            paddingRight: 6,
            paddingBottom: 1,
            paddingLeft: 6,
            borderRadius: 999,
            background: 'rgba(245, 158, 11, 0.12)',
            color: '#b45309',
            fontSize: 10,
            fontWeight: 700,
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
          }}
        >
          {proposals.length}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {proposals.map((proposal) => (
          <DirectiveProposalRow
            key={proposal.id}
            proposal={proposal}
            onAccept={onAccept}
            onDismiss={onDismiss}
            busy={pendingProposalId === proposal.id}
          />
        ))}
      </div>
    </div>
  );
}
