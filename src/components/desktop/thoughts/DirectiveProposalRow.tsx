'use client';

/**
 * #746 / #748 — DirectiveProposalRow.
 *
 * Yellow Issues-style row that surfaces above Open Issues in the Mission
 * panel. Two proposal sources share this chrome:
 *
 *   - `auto` (#746) — recurring (filePattern, fixPattern) pairs from the
 *     local outcome ledger. Renders `<hits>× seen   add directive: pattern → bigram?`
 *   - `cross-repo` (#748) — a stack-similar repo already has this directive.
 *     Renders `<sourceRepo> → <targetRepo>   <directive title>` with a
 *     similarity chip in place of the hits badge.
 *
 * Human-gated: Accept fills the chat composer with a draft directive;
 * Dismiss snoozes the proposal.
 */

import { useCallback, useState } from 'react';
import type { DirectiveProposalCandidate } from './directive-proposal-types';

interface DirectiveProposalRowProps {
  proposal: DirectiveProposalCandidate;
  onAccept: (proposal: DirectiveProposalCandidate) => void;
  onDismiss: (proposal: DirectiveProposalCandidate) => void;
  /** Set true while the dismiss POST is in flight to disable the buttons. */
  busy?: boolean;
}

const YELLOW_ACCENT = '#f59e0b';
const YELLOW_BG_SOFT = 'rgba(245, 158, 11, 0.08)';
const YELLOW_BG_HOVER = 'rgba(245, 158, 11, 0.14)';
const YELLOW_BORDER = 'rgba(245, 158, 11, 0.28)';
const YELLOW_TEXT_DARK = '#b45309';
const FONT_FAMILY = 'var(--font-sans-system)';
const MONO_FAMILY = 'var(--font-mono, "SF Mono", Menlo, monospace)';

function formatObservationProvenance(proposal: Extract<DirectiveProposalCandidate, { source: 'observation' }>) {
  return proposal.laneId && proposal.laneId !== proposal.proposed_by
    ? `${proposal.proposed_by} / ${proposal.laneId}`
    : proposal.proposed_by;
}

export function DirectiveProposalRow({ proposal, onAccept, onDismiss, busy }: DirectiveProposalRowProps) {
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const handleAccept = useCallback(() => {
    if (busy) return;
    onAccept(proposal);
  }, [busy, onAccept, proposal]);

  const handleDismiss = useCallback(() => {
    if (busy) return;
    onDismiss(proposal);
  }, [busy, onDismiss, proposal]);

  const handleRowClick = useCallback(() => {
    setExpanded((current) => !current);
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: hovered ? YELLOW_BG_HOVER : YELLOW_BG_SOFT,
        borderRadius: 8,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: YELLOW_BORDER,
        transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
        fontFamily: FONT_FAMILY,
        overflow: 'hidden',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 34,
          paddingTop: 0,
          paddingRight: 8,
          paddingBottom: 0,
          paddingLeft: 10,
        }}
      >
      <button
        type="button"
        onClick={handleRowClick}
        aria-expanded={expanded}
        title={expanded ? 'Collapse details' : 'Show what this directive says'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flex: 1,
          minWidth: 0,
          height: '100%',
          paddingTop: 0,
          paddingRight: 0,
          paddingBottom: 0,
          paddingLeft: 0,
          borderWidth: 0,
          background: 'transparent',
          cursor: 'pointer',
          fontFamily: FONT_FAMILY,
          textAlign: 'left',
        }}
      >
      {proposal.source === 'cross-repo' ? (
        <CrossRepoBody proposal={proposal} />
      ) : proposal.source === 'observation' ? (
        <ObservationBody proposal={proposal} />
      ) : (
        <AutoBody proposal={proposal} />
      )}
      </button>

      {/* Actions. Mirror the IssueGroupList "+" pattern (transparent buttons,
          tight padding) but with text labels so Accept/Dismiss are explicit. */}
      <button
        type="button"
        onClick={handleAccept}
        disabled={busy}
        title={
          proposal.source === 'cross-repo'
            ? `Import this directive into ${proposal.targetRepoName}`
            : 'Open the directive editor pre-filled with this draft'
        }
        style={{
          flexShrink: 0,
          paddingTop: 3,
          paddingRight: 8,
          paddingBottom: 3,
          paddingLeft: 8,
          borderRadius: 6,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: YELLOW_BORDER,
          background: busy ? 'transparent' : YELLOW_ACCENT,
          color: busy ? YELLOW_TEXT_DARK : '#fff',
          fontSize: 10,
          fontWeight: 700,
          cursor: busy ? 'wait' : 'pointer',
          fontFamily: FONT_FAMILY,
          letterSpacing: '-0.01em',
        }}
      >
        Accept
      </button>
      <button
        type="button"
        onClick={handleDismiss}
        disabled={busy}
        title="Snooze for 30 days"
        style={{
          flexShrink: 0,
          paddingTop: 3,
          paddingRight: 8,
          paddingBottom: 3,
          paddingLeft: 8,
          borderRadius: 6,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: YELLOW_BORDER,
          background: 'transparent',
          color: YELLOW_TEXT_DARK,
          fontSize: 10,
          fontWeight: 700,
          cursor: busy ? 'wait' : 'pointer',
          fontFamily: FONT_FAMILY,
          letterSpacing: '-0.01em',
        }}
      >
        Dismiss
      </button>
      </div>
      {expanded ? (
        <div
          style={{
            paddingTop: 8,
            paddingRight: 12,
            paddingBottom: 12,
            paddingLeft: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            borderTopWidth: 1,
            borderTopStyle: 'solid',
            borderTopColor: YELLOW_BORDER,
            fontFamily: FONT_FAMILY,
          }}
        >
          {proposal.source === 'cross-repo' ? (
            <>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
                {proposal.directiveTitle}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--t-text-secondary)', lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
                {proposal.directiveBody || '(no body)'}
              </div>
              <div style={{ fontSize: 10, color: YELLOW_TEXT_DARK, marginTop: 2 }}>
                Imported from {proposal.sourceRepoName} · {Math.round(proposal.similarity * 100)}% stack overlap with {proposal.targetRepoName}
              </div>
            </>
          ) : proposal.source === 'observation' ? (
            <>
              <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>
                Worker observation:
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--t-text-secondary)', lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
                {proposal.text}
              </div>
              <div style={{ fontSize: 10, color: YELLOW_TEXT_DARK, marginTop: 2 }}>
                Proposed by {formatObservationProvenance(proposal)} · {proposal.scope} · {proposal.kind}
              </div>
              <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 6 }}>
                Draft directive:
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--t-text-secondary)', lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
                {proposal.draftDirective}
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>
                Detected pattern (seen {proposal.hits}× in last 14 days):
              </div>
              <div style={{ fontFamily: MONO_FAMILY, fontSize: 11, color: 'var(--t-text)', whiteSpace: 'pre-wrap' }}>
                {proposal.filePattern} → {proposal.fixPattern}
              </div>
              <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 6 }}>
                Draft directive:
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--t-text-secondary)', lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
                {proposal.draftDirective}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── worker observation body (#1036) ───────────────────────────────────────

function ObservationBody({ proposal }: { proposal: Extract<DirectiveProposalCandidate, { source: 'observation' }> }) {
  return (
    <>
      <span
        title={`Observation scope: ${proposal.scope}`}
        style={{
          width: 42,
          flexShrink: 0,
          fontSize: 10,
          fontWeight: 700,
          color: YELLOW_TEXT_DARK,
          fontFamily: MONO_FAMILY,
          letterSpacing: '-0.01em',
          textTransform: 'uppercase',
        }}
      >
        {proposal.kind.slice(0, 3)}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 12,
          color: 'var(--t-text)',
          letterSpacing: '-0.01em',
        }}
      >
        <span style={{ color: 'var(--t-text-muted)', fontSize: 11 }}>observation: </span>
        <span style={{ fontFamily: MONO_FAMILY, fontSize: 11, color: 'var(--t-text)' }}>
          {proposal.scope}
        </span>
        <span style={{ color: 'var(--t-text-muted)', fontSize: 11 }}> · proposed by </span>
        <span style={{ fontFamily: MONO_FAMILY, fontSize: 11, color: 'var(--t-text)' }}>
          {formatObservationProvenance(proposal)}
        </span>
        <span style={{ color: 'var(--t-text-muted)', fontSize: 11 }}>?</span>
      </span>
    </>
  );
}

// ── auto-proposer body (#746) ──────────────────────────────────────────────

function AutoBody({ proposal }: { proposal: Extract<DirectiveProposalCandidate, { source: 'auto' }> }) {
  return (
    <>
      {/* Hits badge — mirrors the issue-number column width in IssueGroupList. */}
      <span
        title={`Observed ${proposal.hits}× in the last 14 days`}
        style={{
          width: 42,
          flexShrink: 0,
          fontSize: 10,
          fontWeight: 700,
          color: YELLOW_TEXT_DARK,
          fontFamily: MONO_FAMILY,
          letterSpacing: '-0.01em',
        }}
      >
        {proposal.hits}× seen
      </span>

      {/* Pattern preview — file-glob + bigram in monospace so it reads as code. */}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 12,
          color: 'var(--t-text)',
          letterSpacing: '-0.01em',
        }}
      >
        <span style={{ color: 'var(--t-text-muted)', fontSize: 11 }}>add directive: </span>
        <span style={{ fontFamily: MONO_FAMILY, fontSize: 11, color: 'var(--t-text)' }}>
          {proposal.filePattern}
        </span>
        <span style={{ color: 'var(--t-text-muted)', fontSize: 11 }}> → </span>
        <span style={{ fontFamily: MONO_FAMILY, fontSize: 11, color: 'var(--t-text)' }}>
          {proposal.fixPattern}
        </span>
        <span style={{ color: 'var(--t-text-muted)', fontSize: 11 }}>?</span>
      </span>
    </>
  );
}

// ── cross-repo body (#748) ─────────────────────────────────────────────────

function CrossRepoBody({
  proposal,
}: {
  proposal: Extract<DirectiveProposalCandidate, { source: 'cross-repo' }>;
}) {
  // Render similarity as `87%` so the badge stays narrow. Matches the
  // hits-badge column width on auto rows so the layout doesn't shift when
  // the two row kinds are stacked.
  const similarityLabel = `${Math.round(proposal.similarity * 100)}%`;
  return (
    <>
      <span
        title={`Stack overlap: ${similarityLabel} between ${proposal.sourceRepoName} and ${proposal.targetRepoName}`}
        style={{
          width: 42,
          flexShrink: 0,
          fontSize: 10,
          fontWeight: 700,
          color: YELLOW_TEXT_DARK,
          fontFamily: MONO_FAMILY,
          letterSpacing: '-0.01em',
        }}
      >
        {similarityLabel}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 12,
          color: 'var(--t-text)',
          letterSpacing: '-0.01em',
        }}
      >
        <span style={{ color: 'var(--t-text-muted)', fontSize: 11 }}>import from </span>
        <span style={{ fontFamily: MONO_FAMILY, fontSize: 11, color: 'var(--t-text)' }}>
          {proposal.sourceRepoName}
        </span>
        <span style={{ color: 'var(--t-text-muted)', fontSize: 11 }}> → </span>
        <span style={{ fontFamily: MONO_FAMILY, fontSize: 11, color: 'var(--t-text)' }}>
          {proposal.targetRepoName}
        </span>
        <span style={{ color: 'var(--t-text-muted)', fontSize: 11 }}>: </span>
        <span style={{ fontSize: 11, color: 'var(--t-text)' }}>{proposal.directiveTitle}</span>
        <span style={{ color: 'var(--t-text-muted)', fontSize: 11 }}>?</span>
      </span>
    </>
  );
}
