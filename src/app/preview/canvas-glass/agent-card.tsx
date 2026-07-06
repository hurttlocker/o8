'use client';

/**
 * Agent cards — a dispatched worker as a canvas object (Canvas voice/multi-agent
 * spec, 2026-06-19). When voice/canvas spawns agents ("spawn two agents on the
 * auth refactor") they bloom here as numbered glass cards, each bound to a live
 * lane. The phase is HONEST — the same `phaseFor` read the DispatchDock uses
 * (working = the o8 binary orbit, no fabricated %) — and a review-ready lane
 * surfaces its diff right on the card.
 *
 * The card is the surface voice addressing ("agent two") and "ask the room"
 * render on: it carries a visible number + role label and tracks its lane live.
 */

import type { CSSProperties } from 'react';
import { FONT } from './ui';
import { GlassCardShell } from './card-shell';
import { runtimeColor } from '@/lib/agents/codename';
import { PhaseRing, phaseFor, type DispatchLane } from './dispatch-dock';

export const AGENT_MIN_W = 220;
export const AGENT_MIN_H = 76;

export interface AgentCard {
  id: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  /** The lane this card tracks — the live phase/status is looked up by this id. */
  laneId: string;
  /** Stable address number (#1, #2…) — what voice "agent two" resolves to. */
  number: number;
  /** Memorable, voice-friendly name (Atlas, Nova…) — the primary identity the
   *  operator sees and addresses. Deterministic on laneId (see codename.ts). */
  codename: string;
  /** Snapshotted at bloom so the label survives the lane leaving the active set. */
  title: string;
  /** Worker runtime label (codex / claude-code / …), snapshotted at bloom. */
  runtime: string | null;
}

const reviewButton: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--cnv-ink-muted)',
  background: 'rgba(255,255,255,0.1)',
  borderRadius: 999,
  paddingTop: 4,
  paddingBottom: 4,
  paddingLeft: 13,
  paddingRight: 11,
  fontSize: 10.5,
  fontWeight: 500,
  color: 'var(--cnv-ink)',
  cursor: 'pointer',
  fontFamily: FONT,
};

export function AgentGlassCard({
  card,
  lane,
  onMove,
  onResize,
  onFocus,
  onClose,
  onReview,
}: {
  card: AgentCard;
  /** The live lane row (from activeLanes) — null once the lane settles/leaves. */
  lane: DispatchLane | null;
  onMove: (id: number, x: number, y: number) => void;
  onResize: (id: number, w: number, h: number) => void;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
  /** Open this lane's review diff card. */
  onReview: (laneId: string) => void;
}) {
  // A lane that has left the active set has wrapped up — read it as done so the
  // card settles to a check rather than spinning forever.
  const phase = phaseFor(lane ? lane.status : 'done');
  // Number + repo tail — runtime now reads as the colored badge dot, so it leaves
  // the meta line. `#N` stays as the stable secondary address.
  const meta = [`#${card.number}`, lane?.repoPath?.split('/').filter(Boolean).pop()].filter(Boolean).join(' · ');
  const accent = runtimeColor(card.runtime);

  return (
    <GlassCardShell
      card={card}
      cornerHandles
      minW={AGENT_MIN_W}
      minH={AGENT_MIN_H}
      title={card.codename || `Agent ${card.number}`}
      badge={
        card.runtime ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span aria-hidden style={{ width: 6, height: 6, borderRadius: 3, background: accent, flexShrink: 0 }} />
            {card.runtime}
          </span>
        ) : undefined
      }
      onMove={onMove}
      onResize={onResize}
      onFocus={onFocus}
      onClose={onClose}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 2, paddingBottom: 14, paddingLeft: 16, paddingRight: 16, height: card.h, overflow: 'hidden' }}>
        {/* Phase line — the orbit (working) or settled glyph + honest label. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ display: 'inline-flex', width: 16, height: 16, flexShrink: 0 }}>
            <PhaseRing phase={phase} />
          </span>
          <span
            style={{
              fontSize: 13,
              fontWeight: 400,
              letterSpacing: '-0.15px',
              color: phase.key === 'blocked' || phase.key === 'error' ? phase.color : 'var(--cnv-ink)',
              fontFamily: FONT,
            }}
          >
            {phase.label}
          </span>
        </div>

        {/* The task this agent is on + its repo/runtime — the role label voice
            addresses ("the auth agent"). */}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {card.title}
          </div>
          {meta ? (
            <div style={{ marginTop: 2, fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: FONT }}>
              {meta}
            </div>
          ) : null}
        </div>

        {/* Review handoff — the lane is ready, open its diff right here. */}
        {phase.handoff ? (
          <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center' }}>
            <button
              type="button"
              onClick={() => onReview(card.laneId)}
              aria-label={`Review ${card.codename || `agent ${card.number}`}`}
              style={reviewButton}
              onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.18)'; }}
              onMouseLeave={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.1)'; }}
            >
              Review
              <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ pointerEvents: 'none' }}>
                <path d="M7 17 17 7M8 7h9v9" />
              </svg>
            </button>
          </div>
        ) : null}
      </div>
    </GlassCardShell>
  );
}
