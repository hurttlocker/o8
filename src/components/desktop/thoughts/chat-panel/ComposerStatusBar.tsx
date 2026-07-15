'use client';

import { useEffect, useRef, useState } from 'react';
import { AgentStatusDot } from '@/components/desktop/AgentStatusDot';
import type { MobileTranscriptToolCall } from '@/lib/mobile/types';

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(1, '0')}:${s.toString().padStart(2, '0')}`;
}

export function ComposerStatusBar({
  displayWaiting,
  runningTools,
  activeTargetLabel,
  latestUserMessageId,
  awaitingReply,
}: {
  displayWaiting: boolean;
  runningTools: MobileTranscriptToolCall[];
  activeTargetLabel: string;
  latestUserMessageId: string | null;
  awaitingReply: boolean;
}) {
  const startedAtRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // Render-visible mirror of startedAtRef for AgentStatusDot's pulse->orbit
  // switch. Synced from the same tick that drives `elapsed`.
  const [turnStart, setTurnStart] = useState<number | null>(null);
  const prevDisplayWaitingRef = useRef(displayWaiting);
  const prevLatestUserMessageIdRef = useRef<string | null>(latestUserMessageId);
  const hasRunningTools = runningTools.length > 0;
  const [turnLatched, setTurnLatched] = useState(false);
  const active = displayWaiting || hasRunningTools || turnLatched;

  useEffect(() => {
    const risingEdge = displayWaiting && !prevDisplayWaitingRef.current;
    const newUserMessage = latestUserMessageId !== null
      && latestUserMessageId !== prevLatestUserMessageIdRef.current;
    prevDisplayWaitingRef.current = displayWaiting;
    prevLatestUserMessageIdRef.current = latestUserMessageId;
    if (risingEdge || newUserMessage) {
      startedAtRef.current = Date.now();
      const frame = window.requestAnimationFrame(() => {
        setTurnLatched(true);
        setElapsed(0);
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [displayWaiting, latestUserMessageId]);

  useEffect(() => {
    if (turnLatched && !awaitingReply && !displayWaiting && !hasRunningTools) {
      const frame = window.requestAnimationFrame(() => setTurnLatched(false));
      return () => window.cancelAnimationFrame(frame);
    }
  }, [turnLatched, awaitingReply, displayWaiting, hasRunningTools]);

  // Stall ceiling (2026-07-15 six-hour-timer incident): a wedged turn that
  // never produces a reply leaves the transcript ending in a dangling user
  // message, so `awaitingReply` stays true FOREVER and the latch above never
  // releases — the timer counted all night. When the latch is the SOLE thing
  // keeping the bar alive (stream not busy, no running tools), give the reply
  // two minutes to land and then let go. A normal turn never hits this: its
  // reply flips awaitingReply false and the rAF unlatch above wins first.
  useEffect(() => {
    if (!(turnLatched && !displayWaiting && !hasRunningTools)) return;
    const timeout = window.setTimeout(() => setTurnLatched(false), 120_000);
    return () => window.clearTimeout(timeout);
  }, [turnLatched, displayWaiting, hasRunningTools]);

  useEffect(() => {
    if (!active) {
      startedAtRef.current = null;
      const frame = window.requestAnimationFrame(() => { setTurnStart(null); setElapsed(0); });
      return () => window.cancelAnimationFrame(frame);
    }
    if (startedAtRef.current === null) {
      startedAtRef.current = Date.now();
    }
    const tick = () => {
      const anchor = startedAtRef.current;
      setTurnStart(anchor);
      setElapsed(anchor === null ? 0 : Date.now() - anchor);
    };
    const frame = window.requestAnimationFrame(tick);
    const id = window.setInterval(tick, 1000);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(id);
    };
  }, [active]);

  if (!active) return null;

  const runningSummary = hasRunningTools
    ? runningTools.slice(0, 2).map((t) => t.name).join(', ') + (runningTools.length > 2 ? ` +${runningTools.length - 2}` : '')
    : null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`${activeTargetLabel} working for ${formatElapsed(elapsed)}`}
      title={runningSummary ? `Running ${runningSummary}` : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        height: 22,
        marginBottom: 8,
        paddingTop: 0,
        paddingRight: 0,
        paddingBottom: 0,
        paddingLeft: 2,
        background: 'transparent',
        border: 'none',
      }}
    >
      {/* No color override: in the one-canvas family COLOR IS THE STATE —
          muted-grey Breathe read as review's grey Hold-blink (operator
          report 2026-07-12, "reviewing indicator while it was working"). */}
      <AgentStatusDot state="running" startedAt={turnStart} />
      <span style={{
        fontSize: 11.5,
        fontWeight: 500,
        fontFamily: '"SF Mono", ui-monospace, monospace',
        letterSpacing: '0',
        color: 'var(--t-text-muted)',
      }}>
        {formatElapsed(elapsed)}
      </span>
      {hasRunningTools ? (
        <span style={{
          fontSize: 11.5,
          fontWeight: 400,
          letterSpacing: '0',
          color: 'var(--t-text-faint)',
        }}>
          {`· ${runningTools.length} running`}
        </span>
      ) : null}
    </div>
  );
}
