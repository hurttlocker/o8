'use client';

/**
 * ThoughtBlock — the reasoning surface of a turn (turn-grammar deliverable 1,
 * Cursor parity). Replaces the flat one-line "…is thinking" strip.
 *
 * Lifecycle:
 *   • While the model reasons (`live`), the header label "Thinking" carries a
 *     subtle COMPOSITOR-ONLY shimmer (a gradient overlay swept by `transform`,
 *     never background-position — the motion audit flagged text-shimmer paint
 *     loops) and the streamed reasoning text shows live below it.
 *   • The instant reasoning completes (`live` flips false — first answer token
 *     or first tool call ends the thinking phase upstream), it AUTO-COLLAPSES to
 *     one line: "Thought for Ns" + a chevron. Click reopens the full reasoning.
 *
 * DATA REALITY: real thinking deltas DO stream (Claude `thinking_delta` /
 * `thinking_summary`, Codex `reasoning` summary) → `entry.thinking`. Duration is
 * measured client-side as observed reasoning wall-clock (start of live → end);
 * a block hydrated from history without a live phase shows no seconds.
 *
 * Pure inline styles + theme tokens; the shimmer keyframe lives in globals.css.
 */

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

interface ThoughtBlockProps {
  thinking: string;
  /** True while the model is still reasoning (no answer text / no tool yet). */
  live?: boolean;
  style?: CSSProperties;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function formatThoughtDuration(ms: number | null): string {
  if (ms === null) return 'Thought process';
  if (ms < 1000) return 'Thought for <1s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `Thought for ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `Thought for ${minutes}m` : `Thought for ${minutes}m ${rest}s`;
}

export function ThoughtBlock({ thinking, live = false, style }: ThoughtBlockProps) {
  const summary = collapse(thinking);

  // Reduced-motion: read once at mount as an initializer (mirrors ToolCallChip)
  // to avoid the react-hooks/set-state-in-effect rule.
  const [reducedMotion] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  });

  // Reopen state — only meaningful once collapsed (after `live` ends).
  const [expanded, setExpanded] = useState(false);

  // Duration measured client-side as observed reasoning wall-clock. Timing lives
  // in an effect (impure `Date.now()` + ref access belong there, not in render):
  // the start stamps on the first live pass, and the elapsed freezes ONCE — a
  // guarded one-shot setState — on the transition to not-live.
  const startedAtRef = useRef<number | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  useEffect(() => {
    if (live) {
      if (startedAtRef.current === null) startedAtRef.current = Date.now();
      return;
    }
    if (startedAtRef.current !== null && durationMs === null) {
      setDurationMs(Date.now() - startedAtRef.current);
    }
  }, [live, durationMs]);

  if (!summary) return null;

  // While reasoning: always show the streaming text. After completion: show it
  // only when the operator reopens the collapsed summary.
  const showBody = live || expanded;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: showBody ? 6 : 0,
        minWidth: 0,
        maxWidth: '100%',
        paddingTop: 7,
        paddingRight: 10,
        paddingBottom: showBody ? 8 : 7,
        paddingLeft: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: live ? 'color-mix(in srgb, var(--t-accent) 24%, transparent)' : 'var(--t-divider-subtle)',
        background: live
          ? 'color-mix(in srgb, var(--t-accent) 5%, var(--t-bg-card))'
          : 'var(--t-bg-card, rgba(148, 163, 184, 0.06))',
        ...style,
      }}
    >
      <button
        type="button"
        onClick={live ? undefined : () => setExpanded((v) => !v)}
        aria-expanded={live ? undefined : expanded}
        aria-label={live ? 'Model is reasoning' : (expanded ? 'Hide reasoning' : 'Show reasoning')}
        disabled={live}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          width: '100%',
          border: 'none',
          background: 'transparent',
          padding: 0,
          textAlign: 'left',
          cursor: live ? 'default' : 'pointer',
          color: 'var(--t-text-muted)',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 13,
            height: 13,
            flexShrink: 0,
            color: live ? 'var(--t-accent)' : 'var(--t-text-secondary)',
          }}
        >
          <SparkGlyph pulsing={live && !reducedMotion} />
        </span>

        {live ? (
          <span
            className={reducedMotion ? undefined : 'o8-thought-shimmer'}
            style={{
              flexShrink: 0,
              position: 'relative',
              fontFamily: 'var(--font-sans-system)',
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '0.01em',
              color: 'var(--t-accent)',
            }}
          >
            Thinking
            {reducedMotion ? null : <span aria-hidden="true" className="o8-thought-shimmer-band" />}
          </span>
        ) : (
          <span
            style={{
              flexShrink: 0,
              fontFamily: 'var(--font-sans-system)',
              fontSize: 11,
              fontWeight: 460,
              letterSpacing: '0.01em',
              color: 'var(--t-text-secondary)',
            }}
          >
            {formatThoughtDuration(durationMs)}
          </span>
        )}

        {/* Live: a one-line peek of the current reasoning so the block conveys
            motion even before the operator reads the body. Done: a chevron. */}
        {live ? (
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontFamily: '"SFMono-Regular", ui-monospace, Menlo, monospace',
              fontSize: 10.5,
              color: 'var(--t-text-muted)',
            }}
          >
            {`— ${summary}`}
          </span>
        ) : (
          <>
            <span style={{ flex: 1 }} />
            <Chevron open={expanded} />
          </>
        )}
      </button>

      {showBody ? (
        <div
          style={{
            maxHeight: live ? 132 : 320,
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: '"SFMono-Regular", ui-monospace, "Cascadia Code", Menlo, monospace',
            fontSize: 11,
            lineHeight: 1.5,
            letterSpacing: '-0.01em',
            color: 'var(--t-text-muted)',
          }}
        >
          {thinking.trim()}
        </div>
      ) : null}
    </div>
  );
}

function SparkGlyph({ pulsing }: { pulsing: boolean }) {
  return (
    <span style={pulsing ? { display: 'inline-flex', animation: 'o8ToolChipPulse 1.6s ease-in-out infinite' } : undefined}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
        <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
        <path d="M6.5 6.5 9 9M15 15l2.5 2.5M17.5 6.5 15 9M9 15l-2.5 2.5" />
      </svg>
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        display: 'block',
        flexShrink: 0,
        color: 'var(--t-text-faint)',
        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 140ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
