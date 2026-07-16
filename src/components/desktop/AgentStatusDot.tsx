'use client';

/**
 * AgentStatusDot — the canonical agent/run status indicator, one vocabulary for
 * every surface (the /preview/motion lab). Operator lock (Q, 2026-07-12): every
 * status mark now lives on ONE canvas — a 3×3 pixel grid (`.o8-fam`) — so the
 * whole family reads as a single object changing behavior, not five unrelated
 * glyphs. The lock retired the orbit / sweep / dual-pulse / dispatch vocabulary.
 * The family is now COMPLETE on one canvas — every state lives on the grid:
 *   - idle    → "Drift": one faint spark wanders the 3×3 perimeter over 12s,
 *               per-instance random phase so idle walls never pulse in lockstep
 *   - running → "Breathe": center vs ring pulse in anti-phase sine (accent blue)
 *   - review  → "Hourglass": rows drain top → middle → bottom in steps, reset (grey)
 *               (Q pick 2026-07-12 round-2 lab; replaced Hold-blink, may iterate)
 *   - rejected→ "Gravity" in amber — the 8 outer cells fall + fade, then reassemble
 *   - failed  → "Gravity" in red — SAME mark, color = severity (declined vs crash)
 *   - merged  → "Settle": cells pop in staggered and hold ~95% of the cycle (green)
 *
 * The mark is opacity/transform only — no JS timers, no layout animation; every
 * beat lives in the `.o8-fam` keyframes in globals.css. `color` overrides the
 * family hue per surface. `startedAt` is retained for API compatibility (the old
 * pulse→orbit elapsed switch was retired with the family lock). Use this
 * everywhere a run shows activity — chat rows, spawned agents, live sessions, the
 * LLM-chat + orchestrator working indicators.
 */

import { useState, type CSSProperties } from 'react';

export type AgentDotState = 'idle' | 'running' | 'review' | 'rejected' | 'merged' | 'failed';

/**
 * Canonical status → dot-state map. Every agent/session/packet surface routes
 * its (freeform or enum) status string through this ONE function so the motion
 * vocabulary reads identically everywhere — no per-surface drift. Covers the
 * union of every surface's vocabulary (lane status, AgentStatus, VisualStatus,
 * packetVisualState). active/working → working; reviewing (= awaiting review)
 * + anything awaiting the human → review; blocked/failed/error → failed; completed/merged/released →
 * the merged glyph; everything else (queued/draft/idle/archived) → idle.
 */
export function agentStatusToDotState(status?: string | null): AgentDotState {
  switch (status) {
    case 'running':
    case 'active':
    case 'working':
    case 'launching':
    case 'recovering':
      return 'running';
    case 'reviewing':
    case 'huddling':
    case 'waiting':
    case 'awaiting_input':
    case 'awaiting_human':
    case 'awaiting_orchestrator':
    case 'awaiting_review':
    case 'review':
    case 'approval':
    case 'pending':
      return 'review';
    // Reviewed and declined — a settled "no", distinct from a fresh "review me"
    // and a crash ('failed', red). Same Gravity mark, amber (severity = declined).
    case 'rejected':
    case 'needs-revision':
    case 'changes-requested':
    case 'changes_requested':
      return 'rejected';
    case 'blocked':
    case 'failed':
    case 'error':
      return 'failed';
    case 'completed':
    case 'merged':
    case 'released':
      return 'merged';
    default:
      return 'idle';
  }
}

// Status palette (Q ruling 2026-07-11 — "cool the human states"): the decision
// states that wait on a human move OFF the warm band so they stop colliding with
// the orange working orb. Awaiting-review → cool grey ("your turn"). Rejected
// wears the brand orange; FAILED wears bright red (Q ruling 2026-07-16,
// superseding the 2026-07-12 one-orange lock: a crashed run must be
// distinguishable from a declined review at a glance). Same Gravity mark,
// color = severity. Keep in sync with the /preview/motion Status-vocabulary
// board + repo-focus packetStatusColor.
const ACCENT: Record<'running' | 'review' | 'rejected' | 'failed', string> = {
  running: 'var(--t-accent)',
  review: '#94a3b8',
  rejected: '#F97316',
  failed: '#FF3B30',
};

/**
 * FamilyMark — the shared 3×3 canvas. One `<span class="o8-fam fam-*">` with nine
 * `<i />` cells; the variant class drives the keyframes and `--fam-c` the hue.
 */
function FamilyMark({
  variant,
  famColor,
  dotLabel,
  shift,
}: {
  variant: 'fam-working' | 'fam-review' | 'fam-merged' | 'fam-stopped' | 'fam-idle';
  famColor: string;
  dotLabel: string;
  shift?: string;
}) {
  return (
    <span
      className={'o8-fam ' + variant}
      style={{ ['--fam-c']: famColor, ...(shift ? { ['--fam-shift']: shift } : {}) } as CSSProperties}
      aria-label={dotLabel}
      title={dotLabel}
    >
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

export function AgentStatusDot({
  state,
  startedAt: _startedAt,
  color,
  label,
}: {
  state: AgentDotState;
  startedAt?: string | number | null;
  color?: string;
  label?: string;
}) {
  const dotLabel = label ?? defaultDotLabel(state);
  // Per-instance random phase for idle Drift. Lazy initializer so the impure
  // Math.random runs exactly once per mount (never during a re-render — this
  // repo bans impure calls in the render path; lazy state init is the sanctioned
  // pattern). Fed to FamilyMark as --fam-shift so a wall of idle rows never
  // lights the same perimeter cell in lockstep. Hook is unconditional (top of
  // component) even though only the idle branch consumes it.
  const [famShift] = useState(() => `-${(Math.random() * 12).toFixed(2)}s`);

  // running → "Breathe" (anti-phase sine, center vs ring).
  if (state === 'running') {
    return <FamilyMark variant="fam-working" famColor={color ?? ACCENT.running} dotLabel={dotLabel} />;
  }

  // review → "Hold-blink" (grid dim, center lit, rare blink-off — "your turn").
  if (state === 'review') {
    return <FamilyMark variant="fam-review" famColor={color ?? ACCENT.review} dotLabel={dotLabel} />;
  }

  // rejected + failed → "Gravity", one mark, color = severity (amber vs red).
  if (state === 'rejected') {
    return <FamilyMark variant="fam-stopped" famColor={color ?? ACCENT.rejected} dotLabel={dotLabel} />;
  }
  if (state === 'failed') {
    return <FamilyMark variant="fam-stopped" famColor={color ?? ACCENT.failed} dotLabel={dotLabel} />;
  }

  // merged → "Settle" (staggered pop-in, holds most of the cycle).
  if (state === 'merged') {
    return <FamilyMark variant="fam-merged" famColor={color ?? 'var(--t-success)'} dotLabel={dotLabel} />;
  }

  // idle → "Drift" (one faint spark wanders the perimeter over 12s, per-instance
  // desync so idle walls never pulse in lockstep). The family is complete on one
  // canvas — every state now lives on the shared 3×3 grid.
  return <FamilyMark variant="fam-idle" famColor={color ?? 'var(--t-text-faint, #94a3b8)'} dotLabel={dotLabel} shift={famShift} />;
}

function defaultDotLabel(state: AgentDotState): string {
  switch (state) {
    case 'running':
      return 'running';
    case 'review':
      return 'review ready';
    case 'rejected':
      return 'review declined';
    case 'merged':
      return 'merged';
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}
