'use client';

import type { Dispatch, SetStateAction } from 'react';
import { DirectiveProposalRow } from '../thoughts/DirectiveProposalRow';
import type { DirectiveProposalCandidate } from '../thoughts/directive-proposal-types';

interface O8DirectiveProposalDrawerProps {
  proposals: DirectiveProposalCandidate[];
  proposalsOpen: boolean;
  onToggleProposals: () => void;
  unreadProposalCount: number;
  pendingProposalId: string | null;
  newProposalIds: Set<string>;
  onAccept: (proposal: DirectiveProposalCandidate) => void;
  onDismiss: (proposal: DirectiveProposalCandidate) => void;
}

export const PROPOSALS_OPEN_KEY = 'o8:activity:proposals-open';
export const PROPOSALS_SEEN_KEY = 'o8:activity:proposals-seen';

/** Operator-seen proposal ids. Persisted so the "new" emphasis clears across
 *  reloads once reviewed. Always read in an effect, never in render, to avoid
 *  an SSR/CSR hydration mismatch (see the MergePreviewCycler regression). */
export function readSeenProposalIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(PROPOSALS_SEEN_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((x): x is string => typeof x === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
}

export function markProposalsSeen(ids: string[]) {
  if (ids.length === 0) return;
  try {
    const merged = readSeenProposalIds();
    for (const id of ids) merged.add(id);
    const capped = Array.from(merged).slice(-200);
    window.localStorage.setItem(PROPOSALS_SEEN_KEY, JSON.stringify(capped));
  } catch {
    // ignore
  }
}

export function hydrateProposalPrefs(
  setProposalsOpen: Dispatch<SetStateAction<boolean>>,
  setSeenProposalSnapshot: Dispatch<SetStateAction<Set<string>>>,
) {
  try {
    setProposalsOpen(window.localStorage.getItem(PROPOSALS_OPEN_KEY) === '1');
    setSeenProposalSnapshot(readSeenProposalIds());
  } catch {
    // ignore
  }
}

export function O8DirectiveProposalDrawer({
  proposals,
  proposalsOpen,
  onToggleProposals,
  unreadProposalCount,
  pendingProposalId,
  newProposalIds,
  onAccept,
  onDismiss,
}: O8DirectiveProposalDrawerProps) {
  if (proposals.length === 0) return null;
  return (
    <div style={{
      paddingTop: 8,
      paddingRight: 12,
      paddingLeft: 12,
      paddingBottom: 8,
      borderBottom: '1px solid var(--t-divider-subtle, var(--t-divider))',
      marginBottom: 2,
    }}>
      <button
        type="button"
        onClick={onToggleProposals}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          paddingTop: 6,
          paddingRight: 8,
          paddingBottom: 6,
          paddingLeft: 8,
          borderRadius: 8,
          borderWidth: 0,
          background: unreadProposalCount > 0
            ? 'var(--t-accent-soft)'
            : proposalsOpen ? 'var(--t-hover)' : 'transparent',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'var(--font-sans-system)',
          transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
        onMouseEnter={(e) => { if (unreadProposalCount === 0 && !proposalsOpen) e.currentTarget.style.background = 'var(--t-hover)'; }}
        onMouseLeave={(e) => { if (unreadProposalCount === 0 && !proposalsOpen) e.currentTarget.style.background = 'transparent'; }}
        aria-expanded={proposalsOpen}
        title={proposalsOpen ? 'Hide proposed directives' : 'Show proposed directives'}
      >
        <span
          style={{
            width: 10,
            height: 10,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: unreadProposalCount > 0 ? 'var(--t-accent)' : 'var(--t-text-faint)',
            transition: 'transform 150ms cubic-bezier(0.22, 1, 0.36, 1)',
            transform: proposalsOpen ? 'rotate(90deg)' : 'rotate(0deg)',
            flexShrink: 0,
          }}
        >
          <svg width="7" height="7" viewBox="0 0 7 7" fill="currentColor"><path d="M1.5 0.5L5.5 3.5L1.5 6.5Z" /></svg>
        </span>
        <span
          style={{
            fontSize: 9,
            fontWeight: 300,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            color: unreadProposalCount > 0 ? 'var(--t-accent)' : 'var(--t-text-faint)',
            flex: 1,
            minWidth: 0,
          }}
        >
          Proposed directives
        </span>
        {unreadProposalCount > 0 ? (
          <span
            title="New proposals you haven't reviewed yet"
            style={{
              paddingTop: 1,
              paddingRight: 7,
              paddingBottom: 1,
              paddingLeft: 7,
              borderRadius: 999,
              background: 'var(--t-accent)',
              color: '#fff',
              fontSize: 9.5,
              fontWeight: 350,
              letterSpacing: '-0.1px',
              flexShrink: 0,
            }}
          >
            {unreadProposalCount} new
          </span>
        ) : (
          <span
            title="Surfaced when the same fix-pattern appears 3+ times in the last 14 days"
            style={{
              paddingTop: 1,
              paddingRight: 6,
              paddingBottom: 1,
              paddingLeft: 6,
              borderRadius: 999,
              background: 'var(--t-hover)',
              color: 'var(--t-text-faint)',
              fontSize: 9.5,
              fontWeight: 260,
              letterSpacing: '-0.4px',
              flexShrink: 0,
            }}
          >
            {proposals.length}
          </span>
        )}
      </button>
      {proposalsOpen ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4, marginBottom: 4 }}>
          {proposals.map((proposal) => (
            <DirectiveProposalRow
              key={proposal.id}
              proposal={proposal}
              onAccept={onAccept}
              onDismiss={onDismiss}
              busy={pendingProposalId === proposal.id}
              isNew={newProposalIds.has(proposal.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
