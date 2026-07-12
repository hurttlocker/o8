'use client';

/**
 * AgentStatusDot — the canonical agent/run status indicator, one vocabulary for
 * every surface (the /preview/motion lab):
 *   - idle    → A3 static ring (quiet, no motion)
 *   - running → the orbit, always (Q ruling 2026-07-12: the pulse→orbit
 *               long-running split retired; the orbit IS the running period)
 *   - review  → pulse in the review accent (awaiting you)
 *   - merged  → solid success dot
 *   - failed  → the dispatch cross (alarm red)
 *
 * `startedAt` is accepted for API stability — callers still pass their run-start
 * timestamp — but it no longer drives rendering (there's no elapsed→orbit switch
 * anymore). Use this everywhere a run shows activity — chat rows, spawned agents,
 * live sessions, the LLM-chat + orchestrator working indicators.
 */

import { type CSSProperties } from 'react';

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
    // (which pulses) and a crash ('failed', red). Amber, static.
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
// the orange working orb. Awaiting-review → cool indigo ("your turn"); rejected
// → rose (a firm no, distinct from failed's alarm red). Keep these in sync with
// the /preview/motion Status-vocabulary board + repo-focus packetStatusColor.
// Status palette (Q ruling 2026-07-11). Awaiting-review is a PAUSED state — it's
// parked waiting on the human, nothing actively happening — so it carries NO
// color (neutral grey); the sweep MOTION says "for you", not a loud hue. That
// also dodges a collision with the blue working orb (--t-accent === blue). The
// loud colors are reserved for outcomes: rejected → rose, failed → red, merged →
// green. Keep in sync with the /preview/motion board + repo-focus packetStatusColor.
const ACCENT: Record<'running' | 'review' | 'rejected' | 'failed', string> = {
  running: 'var(--t-accent)',
  review: '#94a3b8',
  rejected: '#F97316',
  failed: '#ef4444',
};

export function AgentStatusDot({
  state,
  // startedAt is accepted for API stability (callers still pass their run-start
  // timestamp) but no longer drives rendering — the elapsed→orbit switch retired
  // 2026-07-12. Kept in the signature so removing it doesn't ripple through callers.
  startedAt: _startedAt,
  color,
  label,
}: {
  state: AgentDotState;
  startedAt?: string | number | null;
  color?: string;
  label?: string;
}) {
  const running = state === 'running';
  const dotLabel = label ?? defaultDotLabel(state);

  if (state === 'merged') {
    return (
      <span
        aria-label={dotLabel}
        title={dotLabel}
        style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: color ?? 'var(--t-success)', flexShrink: 0 }}
      />
    );
  }

  if (state === 'failed') {
    // Failed = the DISPATCH pixel mark (packed core spreads to a cross, re-packs)
    // in alarm red — locked by Q 2026-07-12 from the neo-retro loader family.
    // It MOVES so it takes precedence as an active alarm and reads apart from
    // rejected's calmer dual-pulse; the cross-spread gives failed its own
    // silhouette instead of another circle. Dot-scale via .o8-status-size.
    return (
      <span
        className="o8-loader-dispatch o8-status-size"
        style={{ ['--t-loader']: color ?? ACCENT.failed } as CSSProperties}
        aria-label={dotLabel}
        title={dotLabel}
      >
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
    );
  }

  if (state === 'rejected') {
    // Reviewed & declined shares failed's dispatch-cross silhouette — both are
    // stopped and need your click — with COLOR as the severity split: amber
    // (reviewed-and-declined) vs failed's alarm red (crashed). Labels/titles
    // still disambiguate for color-blind operators. (Q ruling 2026-07-12.)
    return (
      <span
        className="o8-loader-dispatch o8-status-size"
        style={{ ['--t-loader']: color ?? ACCENT.rejected } as CSSProperties}
        aria-label={dotLabel}
        title={dotLabel}
      >
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
    );
  }

  if (state === 'review') {
    // Awaiting review = a solid blue circle with a light band SWEEPING across it
    // ("your turn"). The circle holds (stable state); the sweep carries the
    // motion. Base color drives the derived highlight. (Q ruling 2026-07-11.)
    return (
      <span
        className="o8-sweep-circle"
        style={{ ['--sweep-base']: color ?? ACCENT.review } as CSSProperties}
        aria-label={dotLabel}
        title={dotLabel}
      />
    );
  }

  if (running) {
    // Running is always the orbit (Q ruling 2026-07-12: the pulse→orbit
    // long-running split retired — the orbit IS the running period).
    return (
      <span
        className="o8-orbit"
        style={{ color: color ?? ACCENT.running }}
        aria-label={dotLabel}
        title={dotLabel}
      />
    );
  }

  // idle / default → A3 static ring
  return <span className="o8-static-ring" aria-label={dotLabel} title={dotLabel} style={{ width: 5, height: 5 }} />;
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
