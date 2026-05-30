'use client';

/**
 * AgentStatusDot — the canonical agent/run status indicator, one vocabulary for
 * every surface (the /preview/motion lab):
 *   - idle    → A3 static ring (quiet, no motion)
 *   - running → B pulse (accent) — or C binary orbit once the run has been
 *               active past LONG_RUNNING_MS (1 min). Dynamic: flips live.
 *   - review  → pulse in the review accent (awaiting you)
 *   - merged  → purple branch-merge glyph
 *   - failed  → solid red dot
 *
 * `startedAt` is when the current run started working (any parseable timestamp
 * or epoch ms); it drives the pulse→orbit switch. While running, a 30s tick
 * re-renders so a run crossing 7 min surfaces the orbit without an upstream
 * state change. Use this everywhere a run shows activity — chat rows, spawned
 * agents, live sessions, the LLM-chat + orchestrator working indicators.
 */

import { useEffect, useRef, useState } from 'react';

export type AgentDotState = 'idle' | 'running' | 'review' | 'merged' | 'failed';

export const LONG_RUNNING_MS = 1 * 60 * 1000; // 1 min — pulse → orbit (was 7 min; lowered so the long-run orbit is observable)

/**
 * Canonical status → dot-state map. Every agent/session/packet surface routes
 * its (freeform or enum) status string through this ONE function so the motion
 * vocabulary reads identically everywhere — no per-surface drift. Covers the
 * union of every surface's vocabulary (lane status, AgentStatus, VisualStatus,
 * packetVisualState). active/working/reviewing → working; anything awaiting the
 * human → review; blocked/failed/error → failed; completed/merged/released →
 * the merged glyph; everything else (queued/draft/idle/archived) → idle.
 */
export function agentStatusToDotState(status?: string | null): AgentDotState {
  switch (status) {
    case 'running':
    case 'active':
    case 'working':
    case 'launching':
    case 'reviewing':
    case 'recovering':
      return 'running';
    case 'waiting':
    case 'awaiting_input':
    case 'awaiting_orchestrator':
    case 'awaiting_review':
    case 'review':
    case 'approval':
    case 'pending':
      return 'review';
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

const ACCENT: Record<'running' | 'review' | 'failed', string> = {
  running: 'var(--t-accent)',
  review: '#FF5A1F',
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
}: {
  state: AgentDotState;
  startedAt?: string | number | null;
  color?: string;
}) {
  const running = state === 'running';
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

  if (state === 'merged') return <MergedGlyph />;

  if (state === 'failed') {
    return (
      <span
        aria-label="Blocked"
        title="Blocked"
        style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: color ?? ACCENT.failed, flexShrink: 0 }}
      />
    );
  }

  if (state === 'review') {
    return (
      <span
        className="o8-pulse-circle"
        style={{ background: color ?? ACCENT.review }}
        aria-label="Awaiting review"
        title="Awaiting review"
      />
    );
  }

  if (running) {
    return longRunning ? (
      <span
        className="o8-orbit"
        style={{ color: color ?? ACCENT.running }}
        aria-label="Working — long-running"
        title="Working — long-running"
      />
    ) : (
      <span
        className="o8-pulse-circle"
        style={{ background: color ?? ACCENT.running }}
        aria-label="Working"
        title="Working"
      />
    );
  }

  // idle / default → A3 static ring
  return <span className="o8-static-ring" aria-hidden style={{ width: 5, height: 5 }} />;
}

/** Purple branch-merge mark — static, breaks the gray rhythm without claiming
 *  attention. Kept identical to the legacy HistoryRows glyph. */
function MergedGlyph() {
  return (
    <span
      aria-label="Merged"
      title="Merged"
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 9, height: 9, flexShrink: 0, color: '#8b5cf6' }}
    >
      <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="3" cy="3" r="1.5" />
        <circle cx="3" cy="9" r="1.5" />
        <circle cx="9" cy="6" r="1.5" />
        <path d="M3 4.5v3" />
        <path d="M4.5 3c0 1.5 1.5 3 3 3" />
      </svg>
    </span>
  );
}
