'use client';

import { useState } from 'react';
import { MarkdownBody } from '@/components/desktop/MarkdownBody';

interface CollapsiblePlanCardProps {
  text: string;
  compact?: boolean;
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        display: 'block',
        flexShrink: 0,
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      aria-hidden="true"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function CollapsiblePlanCard({ text, compact = false }: CollapsiblePlanCardProps) {
  const normalizedText = text.trim();
  const [open, setOpen] = useState(false);

  if (!normalizedText) {
    return null;
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-glass-border-strong, rgba(148, 163, 184, 0.2))',
        borderRadius: compact ? 14 : 16,
        backgroundColor: 'var(--t-panel, rgba(255, 255, 255, 0.82))',
        // Flat. --t-glass-shadow is chrome elevation (0 18px 38px) and it read
        // as a stuck hover against the transcript's flat text — the same call
        // as the system cards above it (Q 2026-07-16).
        boxShadow: 'none',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          width: '100%',
          paddingTop: compact ? 10 : 12,
          paddingRight: compact ? 12 : 14,
          paddingBottom: compact ? 10 : 12,
          paddingLeft: compact ? 12 : 14,
          borderWidth: 0,
          backgroundColor: 'transparent',
          color: 'var(--t-text, #0f172a)',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontSize: compact ? 11 : 12,
              fontWeight: 700,
              letterSpacing: '-0.01em',
            }}
          >
            Plan
          </span>
          <span
            style={{
              fontSize: compact ? 10 : 11,
              color: 'var(--t-text-muted, #64748b)',
              letterSpacing: '-0.01em',
            }}
          >
            {open ? 'Hide the first-turn plan' : 'Show the first-turn plan'}
          </span>
        </div>
        <ChevronIcon open={open} />
      </button>

      {open ? (
        <div
          style={{
            paddingTop: 0,
            paddingRight: compact ? 12 : 14,
            paddingBottom: compact ? 12 : 14,
            paddingLeft: compact ? 12 : 14,
            borderTopWidth: 1,
            borderTopStyle: 'solid',
            borderTopColor: 'var(--t-divider-subtle, rgba(148, 163, 184, 0.18))',
            backgroundColor: 'var(--t-bg-card)',
          }}
        >
          <MarkdownBody text={normalizedText} compact={compact} />
        </div>
      ) : null}
    </div>
  );
}
