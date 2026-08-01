'use client';

/**
 * DispatchDock — a live "agents working" panel that grows out of the top of the
 * canvas composer (2026-06-15). The pattern: a panel that expands out of the
 * prompt bar with staggered rows + per-row progress rings; here the rows
 * are REAL dispatched packets (page.tsx `activeLanes`), not image workflows.
 *
 * o8-specific moves:
 *  - The working ring is OUR motion — the `.o8-orbit` binary orbit (two dots
 *    circling a center, motion vocabulary C), not a generic spinner.
 *  - NO fabricated percentages. Codex/Claude don't emit deterministic progress,
 *    so a "36%" ring would be theater — we show an HONEST phase from real status.
 *  - The ↗ completion handoff opens the lane's diff/review card (ties into the
 *    canvas diff-card system) instead of morphing an image in place.
 *  - Panel uses the media-card frost (`glassMedia`) — same transparency as the
 *    frame around photo/video cards — with white icons.
 *
 * Lives in the same floating column as the queued-sends + undo-send pills, so
 * the composer's queue and this dock stack and never collide.
 */

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FONT, glassMedia, TONE_DOT } from './ui';

/** A live dispatched-agent row — structurally page.tsx's LaneRow (activeLanes),
 *  kept loose so the host passes them straight through. */
export interface DispatchLane {
  id: string;
  packetId?: string | null;
  sessionKey?: string | null;
  label?: string | null;
  repoPath?: string | null;
  status?: string | null;
  runtime?: string | null;
  /** Lane creation (ISO) — origin for the live/settled duration. */
  createdAt?: string | null;
  /** Last write (ISO) — freeze point for a settled lane's ran-duration. */
  updatedAt?: string | null;
  /** Last event (ISO) — preferred freeze point; the moment work last moved. */
  lastEventAt?: string | null;
}

type PhaseKey = 'working' | 'finalizing' | 'review' | 'blocked' | 'done' | 'error';

export interface Phase {
  key: PhaseKey;
  label: string;
  color: string;
  ring: 'orbit' | 'check' | 'review' | 'dot';
  /** pulse the status text (the reference's "Agent finalizing…" shimmer) */
  shimmer?: boolean;
  /** the row is a handoff — surface the ↗ Review action */
  handoff?: boolean;
}

const ICON = 'rgba(255,255,255,0.95)'; // white icons on the frosted media-frame panel
const WAITING = TONE_DOT.waiting;      // amber — "needs you" must still pop
const ERROR = '#ef4444';               // red — failures must still pop

/** How many rows before the cap kicks in (then a "+N more" row). */
const ROW_CAP = 4;

/** Map a raw lane status → an HONEST phase. Keyword-matched so it survives the
 *  exact status strings drifting (running / reviewing / awaiting_* / merged …). */
export function phaseFor(status?: string | null): Phase {
  const s = (status ?? '').toLowerCase();
  if (/review|approv/.test(s)) return { key: 'review', label: 'Ready for review', color: ICON, ring: 'review', handoff: true };
  if (/merged|done|complete|success/.test(s)) return { key: 'done', label: 'Done', color: ICON, ring: 'check' };
  if (/final|commit/.test(s)) return { key: 'finalizing', label: 'Finalizing', color: ICON, ring: 'orbit', shimmer: true };
  if (/await|block|human|recover|base-moved|conflict|paused/.test(s)) return { key: 'blocked', label: 'Needs you', color: WAITING, ring: 'dot' };
  if (/error|fail|exit|dead|crash/.test(s)) return { key: 'error', label: 'Failed', color: ERROR, ring: 'dot' };
  return { key: 'working', label: 'Working', color: ICON, ring: 'orbit' };
}

function laneTitle(lane: DispatchLane): string {
  return lane.label?.trim() || lane.repoPath?.split('/').filter(Boolean).pop() || lane.id;
}

/** The phase mark. Working/finalizing = the o8 binary orbit (OUR motion);
 *  review/done/blocked/error = a static glyph. 14px, at the row head. */
export function PhaseRing({ phase }: { phase: Phase }) {
  const c = phase.color;
  if (phase.ring === 'orbit') {
    // Motion vocabulary C — two dots 180° apart circling a center (globals.css
    // .o8-orbit). currentColor → the dots; we run it white.
    return <span aria-hidden className="o8-orbit" style={{ width: 14, height: 14, color: c, flexShrink: 0 }} />;
  }
  if (phase.ring === 'check') {
    return (
      <span aria-hidden style={{ display: 'inline-flex', width: 14, height: 14, flexShrink: 0 }}>
        <svg width={14} height={14} viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6" stroke={c} strokeWidth="2" />
          <path d="m5.4 8 1.9 1.9L11 6" stroke={c} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (phase.ring === 'review') {
    // Clipboard-check — the canvas's own "Review diffs" glyph (page.tsx dock).
    return (
      <span aria-hidden style={{ display: 'inline-flex', width: 14, height: 14, flexShrink: 0 }}>
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          <rect width="8" height="4" x="8" y="2" rx="1" />
          <path d="m9 14 2 2 4-4" />
        </svg>
      </span>
    );
  }
  return <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: c, flexShrink: 0, margin: 3 }} />;
}

function DispatchRow({
  lane, phase, index, onSelect, onReview,
}: {
  lane: DispatchLane;
  phase: Phase;
  index: number;
  onSelect: (lane: DispatchLane) => void;
  onReview: (lane: DispatchLane) => void;
}) {
  const meta = [lane.runtime, lane.repoPath?.split('/').filter(Boolean).pop()].filter(Boolean).join(' · ');
  const done = phase.key === 'done';
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: done ? 0.55 : 1, y: 0 }}
      transition={{ delay: index * 0.04, type: 'spring', stiffness: 460, damping: 34 }}
      style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 7, paddingBottom: 7, paddingLeft: 8, paddingRight: 6, borderRadius: 10 }}
      onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--cnv-tint)'; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
    >
      <PhaseRing phase={phase} />
      <button
        type="button"
        onClick={() => onSelect(lane)}
        style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'flex-start', borderWidth: 0, background: 'transparent', cursor: 'pointer', fontFamily: FONT, textAlign: 'left' }}
      >
        <span style={{ width: '100%', fontSize: 11.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {laneTitle(lane)}
        </span>
        {meta ? (
          <span style={{ width: '100%', fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {meta}
          </span>
        ) : null}
      </button>
      {phase.handoff ? (
        <button
          type="button"
          onClick={() => onReview(lane)}
          aria-label="Open review"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, borderWidth: 0, background: 'var(--cnv-tint)', borderRadius: 999, paddingTop: 3, paddingBottom: 3, paddingLeft: 9, paddingRight: 8, cursor: 'pointer', fontFamily: FONT, fontSize: 10, fontWeight: 400, color: 'var(--cnv-ink)', flexShrink: 0 }}
          onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--cnv-tint-deep)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = 'var(--cnv-tint)'; }}
        >
          Review
          <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M7 17 17 7M8 7h9v9" />
          </svg>
        </button>
      ) : (
        <motion.span
          animate={phase.shimmer ? { opacity: [0.5, 1, 0.5] } : { opacity: 1 }}
          transition={phase.shimmer ? { repeat: Infinity, duration: 1.6, ease: 'easeInOut' } : { duration: 0.2 }}
          style={{ fontSize: 10, fontWeight: 300, color: phase.key === 'blocked' || phase.key === 'error' ? phase.color : 'var(--cnv-ink-muted)', fontFamily: FONT, flexShrink: 0, letterSpacing: '-0.1px' }}
        >
          {phase.label}
        </motion.span>
      )}
    </motion.div>
  );
}

/** The dock. Collapsed (default) = a one-line summary bar with the live orbit;
 *  expanded = the staggered packet list (capped, with "+N more"). Returns null
 *  with no lanes (composer is bare). */
export function DispatchDock({
  lanes, onSelect, onReview, onExpandedChange,
}: {
  lanes: DispatchLane[];
  onSelect: (lane: DispatchLane) => void;
  onReview: (lane: DispatchLane) => void;
  /** Report the tray's expanded state up so the host can re-reserve grid space
   *  for the taller tray (the expanded rows add ~110px above the summary bar). */
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const phased = useMemo(() => lanes.map((lane) => ({ lane, phase: phaseFor(lane.status) })), [lanes]);
  // Kept before the early return so the hook order is stable (mount reports the
  // collapsed default, syncing the host even after a prior tray unmounted expanded).
  useEffect(() => { onExpandedChange?.(expanded); }, [expanded, onExpandedChange]);
  if (!phased.length) return null;

  const workingCount = phased.filter((entry) => entry.phase.key === 'working' || entry.phase.key === 'finalizing').length;
  const reviewCount = phased.filter((entry) => entry.phase.key === 'review').length;
  const blockedCount = phased.filter((entry) => entry.phase.key === 'blocked' || entry.phase.key === 'error').length;
  const anyWorking = workingCount > 0;

  const summary = [
    workingCount ? `${workingCount} working` : null,
    reviewCount ? `${reviewCount} to review` : null,
    blockedCount ? `${blockedCount} need you` : null,
  ].filter(Boolean).join(' · ') || 'all settled';

  const capped = showAll ? phased : phased.slice(0, ROW_CAP);
  const overflow = phased.length - capped.length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
      style={{ width: '100%', borderRadius: 16, overflow: 'hidden', pointerEvents: 'auto', ...glassMedia() }}
    >
      {/* Collapsed summary bar — the panel head that grows the list out. */}
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse agents' : 'Expand agents'}
        style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', borderWidth: 0, background: 'transparent', cursor: 'pointer', paddingTop: 9, paddingBottom: 9, paddingLeft: 12, paddingRight: 10, fontFamily: FONT, textAlign: 'left' }}
      >
        {anyWorking ? (
          <PhaseRing phase={{ key: 'working', label: '', color: ICON, ring: 'orbit' }} />
        ) : reviewCount ? (
          <PhaseRing phase={{ key: 'review', label: '', color: ICON, ring: 'review' }} />
        ) : (
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: blockedCount ? WAITING : 'var(--cnv-ink-muted)', margin: 3, flexShrink: 0 }} />
        )}
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span style={{ fontSize: 11.5, fontWeight: 400, letterSpacing: '-0.1px', color: 'var(--cnv-ink)' }}>
            {phased.length} agent{phased.length === 1 ? '' : 's'}{anyWorking ? ' working' : ''}
          </span>
          <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)' }}>{summary}</span>
        </span>
        <svg
          width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--cnv-ink-muted)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden
          style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 160ms ease', opacity: 0.7, flexShrink: 0 }}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {/* Staggered packet list (reference's slide-up reveal), capped. */}
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="rows"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', paddingBottom: 6, paddingLeft: 6, paddingRight: 6 }}>
              {capped.map(({ lane, phase }, index) => (
                <DispatchRow key={lane.id} lane={lane} phase={phase} index={index} onSelect={onSelect} onReview={onReview} />
              ))}
              {overflow > 0 || showAll ? (
                <button
                  type="button"
                  onClick={() => setShowAll((value) => !value)}
                  style={{ borderWidth: 0, background: 'transparent', cursor: 'pointer', paddingTop: 6, paddingBottom: 4, paddingLeft: 8, paddingRight: 8, textAlign: 'left', fontFamily: FONT, fontSize: 9.5, fontWeight: 300, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)' }}
                  onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
                  onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
                >
                  {overflow > 0 ? `+${overflow} more` : 'Show less'}
                </button>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}
