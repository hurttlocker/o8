'use client';

/**
 * #746 — DirectiveProposalRow.
 *
 * Yellow Issues-style row that surfaces above Open Issues in the Mission
 * panel when the auto-directive proposer detects a recurring fix-pattern.
 * Human-gated: Accept fills the chat composer with a draft directive;
 * Dismiss snoozes the proposal for 30 days.
 *
 * The row mirrors the `IssueGroupList` row chrome (dense, 34px tall, no
 * card outline) but tinted yellow so the operator notices it without it
 * dominating the panel. Multiple proposals stack as sibling rows under a
 * single header.
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
const FONT_FAMILY = '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif';
const MONO_FAMILY = 'var(--font-mono, "SF Mono", Menlo, monospace)';

export function DirectiveProposalRow({ proposal, onAccept, onDismiss, busy }: DirectiveProposalRowProps) {
  const [hovered, setHovered] = useState(false);

  const handleAccept = useCallback(() => {
    if (busy) return;
    onAccept(proposal);
  }, [busy, onAccept, proposal]);

  const handleDismiss = useCallback(() => {
    if (busy) return;
    onDismiss(proposal);
  }, [busy, onDismiss, proposal]);

  return (
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
        background: hovered ? YELLOW_BG_HOVER : YELLOW_BG_SOFT,
        borderRadius: 8,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: YELLOW_BORDER,
        transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
        fontFamily: FONT_FAMILY,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
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

      {/* Actions. Mirror the IssueGroupList "+" pattern (transparent buttons,
          tight padding) but with text labels so Accept/Dismiss are explicit. */}
      <button
        type="button"
        onClick={handleAccept}
        disabled={busy}
        title="Open the directive editor pre-filled with this draft"
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
  );
}
