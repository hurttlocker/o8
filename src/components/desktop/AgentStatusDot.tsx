'use client';

/**
 * AgentStatusDot — the canonical agent/run status indicator, one vocabulary for
 * every surface (the /preview/motion lab):
 *   - idle    → A3 static ring (quiet, no motion)
 *   - running → B pulse (accent) — or C binary orbit once the run has been
 *               active past LONG_RUNNING_MS (1 min). Dynamic: flips live.
 *   - review  → pulse in the review accent (awaiting you)
 *   - merged  → solid success dot
 *   - failed  → solid red dot
 *
 * `startedAt` is when the current run started working (any parseable timestamp
 * or epoch ms); it drives the pulse→orbit switch. While running, a 30s tick
 * re-renders so a run crossing 7 min surfaces the orbit without an upstream
 * state change. Use this everywhere a run shows activity — chat rows, spawned
 * agents, live sessions, the LLM-chat + orchestrator working indicators.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';

export type AgentDotState = 'idle' | 'running' | 'review' | 'rejected' | 'merged' | 'failed';

export const LONG_RUNNING_MS = 1 * 60 * 1000; // 1 min — pulse → orbit (was 7 min; lowered so the long-run orbit is observable)

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

function toMs(value: string | number | null | undefined): number {
  if (value == null) return NaN;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function AgentStatusDot({
  state,
  startedAt,
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
  // Elapsed → orbit switch. Prefer an explicit `startedAt` (surfaces that know
  // their real run-start, e.g. a streaming turn); otherwise fall back to when
  // this dot was first observed running. All time math lives in the effect
  // (Date.now is impure — can't run during render); render just reads the
  // boolean. A 30s tick re-computes so a run crossing the threshold flips to
  // the orbit live, no upstream state change required.
  const observedStartRef = useRef<number | null>(null);
  const [longRunning, setLongRunning] = useState(false);
  useEffect(() => {
    // Not running: clear the observed-start ref. No state reset needed — render
    // ignores longRunning unless running, and a fresh run resets it below.
    if (!running) { observedStartRef.current = null; return; }
    if (observedStartRef.current == null) observedStartRef.current = Date.now();
    const compute = () => {
      const explicit = toMs(startedAt);
      const startMs = Number.isFinite(explicit) ? explicit : observedStartRef.current;
      // Timer-driven derived state: depends on wall-clock elapsed, which can't
      // be computed during render (Date.now is impure there). Recomputed on the
      // effect pass + every 30s; a fresh run resets it to false on its own pass.
      setLongRunning(startMs != null && Number.isFinite(startMs) && Date.now() - startMs >= LONG_RUNNING_MS);
    };
    compute();
    const id = window.setInterval(compute, 30_000);
    return () => window.clearInterval(id);
  }, [running, startedAt]);

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
    // Failed = the working orb, in red: it MOVES (pulses) so it takes precedence
    // as an active alarm — "look now" — and reads clearly apart from rejected's
    // STATIC rose, even though both are red-ish. Motion is the separator; a
    // crash is live and loud, a declined review is settled and calm. (Q, 2026-07-11.)
    return (
      <span
        className="o8-pulse-circle"
        style={{ background: color ?? ACCENT.failed }}
        aria-label={dotLabel}
        title={dotLabel}
      />
    );
  }

  if (state === 'rejected') {
    // Reviewed & declined: the o8 dual-pulse (small + large circle, offset) in
    // orange. The o8 mark + motion make it distinct from failed's single red
    // pulse and from the calm outcome states. (Q trial 2026-07-11.)
    return (
      <span
        className="o8-dual-pulse"
        style={{ ['--dp-color']: color ?? ACCENT.rejected } as CSSProperties}
        aria-label={dotLabel}
        title={dotLabel}
      >
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
    return longRunning ? (
      <span
        className="o8-orbit"
        style={{ color: color ?? ACCENT.running }}
        aria-label={`${dotLabel} — long-running`}
        title={`${dotLabel} — long-running`}
      />
    ) : (
      <span
        className="o8-pulse-circle"
        style={{ background: color ?? ACCENT.running }}
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
