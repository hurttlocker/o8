'use client';

/**
 * SuggestedReplies — Augment Intent-style chip row under an assistant message.
 *
 * Pure component. The parent owns the chip strings + dismissed/cached state;
 * this just renders + reports clicks.
 *
 * Closes #771.
 */
import { useState, useSyncExternalStore } from 'react';

interface SuggestedRepliesProps {
  chips: string[];
  disabled?: boolean;
  onSelect: (chip: string) => void;
  onDismiss: () => void;
}

// Rams "one orange" — matches the orchestrator accent already used in ThoughtsChatPanel
// (line ~661, activeTargetColor for orchestrator mode). Hardcoded because the global
// `--t-accent` is the blue product accent, and the design language calls for the
// single orange ink for Coordinator surfaces.
const ORCHESTRATOR_ACCENT = '#e07a3a';

const CLOSE_PATH = 'M208,202.74,121.26,116a8,8,0,0,0-11.32,0L24.2,202.74a8,8,0,0,0,11.31,11.32L116,133.59l80.49,80.47a8,8,0,0,0,11.31-11.32Z';

function subscribeReducedMotion(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  try {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    media.addEventListener('change', callback);
    return () => media.removeEventListener('change', callback);
  } catch {
    return () => {};
  }
}

function getReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function getReducedMotionServerSnapshot(): boolean {
  return false;
}

export function SuggestedReplies({ chips, disabled = false, onSelect, onDismiss }: SuggestedRepliesProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [dismissHover, setDismissHover] = useState(false);
  const reduceMotion = useSyncExternalStore(subscribeReducedMotion, getReducedMotion, getReducedMotionServerSnapshot);

  if (chips.length === 0) return null;

  const filteredChips = chips.filter((chip) => chip.trim().length > 0);
  if (filteredChips.length === 0) return null;

  return (
    <div
      role="group"
      aria-label="Suggested replies"
      style={{
        alignSelf: 'flex-start',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
        marginTop: 4,
        marginLeft: 2,
        opacity: disabled ? 0.45 : 1,
        transition: reduceMotion ? 'none' : 'opacity 160ms ease',
      }}
    >
      {filteredChips.map((chip, index) => {
        const isHovered = !disabled && hoveredIndex === index;
        return (
          <button
            key={`${chip}-${index}`}
            type="button"
            disabled={disabled}
            onClick={() => {
              if (disabled) return;
              onSelect(chip);
            }}
            onMouseEnter={() => setHoveredIndex(index)}
            onMouseLeave={() => setHoveredIndex((current) => (current === index ? null : current))}
            style={{
              appearance: 'none',
              cursor: disabled ? 'default' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              fontFamily: '"Plus Jakarta Sans", system-ui, sans-serif',
              fontSize: 12,
              fontWeight: 500,
              letterSpacing: '-0.01em',
              lineHeight: 1.2,
              paddingTop: 5,
              paddingRight: 10,
              paddingBottom: 5,
              paddingLeft: 10,
              borderRadius: 999,
              borderTopWidth: 1,
              borderRightWidth: 1,
              borderBottomWidth: 1,
              borderLeftWidth: 1,
              borderTopStyle: 'solid',
              borderRightStyle: 'solid',
              borderBottomStyle: 'solid',
              borderLeftStyle: 'solid',
              borderTopColor: isHovered ? ORCHESTRATOR_ACCENT : 'var(--t-divider-subtle, rgba(0,0,0,0.08))',
              borderRightColor: isHovered ? ORCHESTRATOR_ACCENT : 'var(--t-divider-subtle, rgba(0,0,0,0.08))',
              borderBottomColor: isHovered ? ORCHESTRATOR_ACCENT : 'var(--t-divider-subtle, rgba(0,0,0,0.08))',
              borderLeftColor: isHovered ? ORCHESTRATOR_ACCENT : 'var(--t-divider-subtle, rgba(0,0,0,0.08))',
              background: isHovered ? 'var(--t-panel-hover, rgba(0,0,0,0.04))' : 'transparent',
              color: isHovered ? ORCHESTRATOR_ACCENT : 'var(--t-text-secondary, var(--t-text, #5b6475))',
              transition: reduceMotion ? 'none' : 'border-color 140ms ease, background 140ms ease, color 140ms ease',
              maxWidth: 280,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {chip}
          </button>
        );
      })}

      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          onDismiss();
        }}
        onMouseEnter={() => setDismissHover(true)}
        onMouseLeave={() => setDismissHover(false)}
        aria-label="Dismiss suggested replies"
        style={{
          appearance: 'none',
          cursor: disabled ? 'default' : 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 22,
          borderRadius: 999,
          borderTopWidth: 0,
          borderRightWidth: 0,
          borderBottomWidth: 0,
          borderLeftWidth: 0,
          background: dismissHover && !disabled ? 'var(--t-panel-hover, rgba(0,0,0,0.06))' : 'transparent',
          color: dismissHover && !disabled
            ? 'var(--t-text, #111827)'
            : 'var(--t-text-tertiary, var(--t-text-secondary, #9ca3af))',
          transition: reduceMotion ? 'none' : 'background 120ms ease, color 120ms ease',
          padding: 0,
        }}
      >
        <svg width={11} height={11} viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
          <path d={CLOSE_PATH} />
        </svg>
      </button>
    </div>
  );
}
