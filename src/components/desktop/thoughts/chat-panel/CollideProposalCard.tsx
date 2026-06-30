'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Collide (MoA) pre-roll card — the FAINT half of Collide's visual identity.
 *
 * Two independent proposals (Claude's first pass + Codex's take) render in faint
 * light-grey (`var(--t-text-faint)`), collapsible, recessive — present but quiet.
 * The synthesized answer that follows streams in regular ink. The contrast IS the
 * feature: faint proposals → solid synthesis, so the collision→synthesis reads at
 * a glance without shouting. Restrained per hurttlocker (eye-ergonomics, not flash).
 *
 * Inline styles only (Critical Rule — no CSS classes).
 */

interface CollideProposal {
  proposer: string;
  text: string;
  breach: boolean;
}

interface CollideState {
  phase: 'proposing' | 'synthesizing';
  proposers: string[];
  proposals: CollideProposal[];
}

function CollideGlyph() {
  // Two converging rings — a quiet "collision".
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <circle cx="9" cy="12" r="6" />
      <circle cx="15" cy="12" r="6" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      aria-hidden="true"
      style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 140ms ease' }}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function CollideProposalCard({ collide }: { collide: CollideState }) {
  const proposing = collide.phase === 'proposing';
  const [expanded, setExpanded] = useState(true);
  const prevPhase = useRef(collide.phase);

  // Recede once synthesis starts — auto-collapse on the proposing→synthesizing
  // edge, then leave it to the operator. The faint card steps back so the
  // synthesized answer below is the thing in focus.
  useEffect(() => {
    if (prevPhase.current === 'proposing' && collide.phase === 'synthesizing') {
      setExpanded(false);
    }
    prevPhase.current = collide.phase;
  }, [collide.phase]);

  const returned = new Set(collide.proposals.map((p) => p.proposer));
  const pending = collide.proposers.filter((p) => !returned.has(p));
  const title = collide.proposers.join('  ×  ') || 'Collide';
  const stateLabel = proposing
    ? (pending.length ? `${pending.join(', ')} proposing…` : 'colliding…')
    : `${collide.proposals.length} proposal${collide.proposals.length === 1 ? '' : 's'} collided`;

  return (
    <div
      role="group"
      aria-label="Collide proposals"
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider)',
        background: 'transparent',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          paddingTop: 8,
          paddingRight: 10,
          paddingBottom: 8,
          paddingLeft: 11,
          background: 'transparent',
          borderWidth: 0,
          cursor: 'pointer',
          textAlign: 'left',
          width: '100%',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 14,
            height: 14,
            color: 'var(--t-text-faint)',
            flexShrink: 0,
            opacity: proposing ? 0.9 : 0.7,
          }}
        >
          <CollideGlyph />
        </span>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span
            style={{
              color: 'var(--t-text-faint)',
              fontSize: 12,
              fontWeight: 500,
              letterSpacing: '-0.1px',
              lineHeight: 1.25,
              whiteSpace: 'nowrap',
            }}
          >
            {title}
          </span>
          <span
            style={{
              color: 'var(--t-text-faint)',
              fontSize: 9.5,
              fontWeight: 260,
              letterSpacing: '-0.2px',
              lineHeight: 1.25,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              opacity: 0.85,
            }}
          >
            {stateLabel}
          </span>
        </div>

        <span aria-hidden="true" style={{ color: 'var(--t-text-faint)', display: 'inline-flex', opacity: 0.7, flexShrink: 0 }}>
          <Chevron open={expanded} />
        </span>
      </button>

      {expanded ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            paddingTop: 2,
            paddingRight: 12,
            paddingBottom: 11,
            paddingLeft: 12,
          }}
        >
          {collide.proposals.map((p, i) => (
            <div key={`${p.proposer}-${i}`} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span
                style={{
                  color: 'var(--t-text-faint)',
                  fontSize: 9,
                  fontWeight: 600,
                  letterSpacing: '0.4px',
                  textTransform: 'uppercase',
                  opacity: 0.8,
                }}
              >
                {p.proposer}
                {p.breach ? ' · attempted to act — blocked' : ''}
              </span>
              <div
                style={{
                  color: 'var(--t-text-faint)',
                  fontSize: 12,
                  fontWeight: 300,
                  lineHeight: 1.5,
                  letterSpacing: '-0.1px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 220,
                  overflowY: 'auto',
                  // Soft edge-fade so a long proposal dissolves rather than hard-cuts.
                  maskImage: 'linear-gradient(to bottom, #000 0, #000 calc(100% - 16px), transparent 100%)',
                  WebkitMaskImage: 'linear-gradient(to bottom, #000 0, #000 calc(100% - 16px), transparent 100%)',
                }}
              >
                {p.breach ? '(excluded for safety — this proposer was read-only and tried to act)' : (p.text || '…')}
              </div>
            </div>
          ))}
          {pending.map((name) => (
            <div key={`pending-${name}`} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span
                style={{
                  color: 'var(--t-text-faint)',
                  fontSize: 9,
                  fontWeight: 600,
                  letterSpacing: '0.4px',
                  textTransform: 'uppercase',
                  opacity: 0.55,
                }}
              >
                {name}
              </span>
              <div style={{ color: 'var(--t-text-faint)', fontSize: 12, fontWeight: 300, opacity: 0.55 }}>
                proposing…
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
