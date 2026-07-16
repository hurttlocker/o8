'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, PenLine } from '../../lucide-shims';
import type { DesignDrawContext } from './design-draw-context';

// Compact strip under a design-draw prompt: one quiet row summarizing the
// captured context (region + element count), expandable to the raw block.
// The raw block still travels in the message text (the model needs it) —
// this only changes how the transcript renders it.
export function DesignDrawContextCard({ context }: { context: DesignDrawContext }) {
  const [expanded, setExpanded] = useState(false);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div style={{
      width: '100%',
      borderRadius: 10,
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: 'var(--t-divider)',
      background: 'var(--t-bg-card)',
      overflow: 'hidden',
    }}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          width: '100%',
          paddingTop: 7,
          paddingRight: 12,
          paddingBottom: 7,
          paddingLeft: 12,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <PenLine size={12} strokeWidth={1.8} style={{ color: 'var(--t-text-secondary)', flexShrink: 0 }} />
        <span style={{
          fontSize: 11,
          fontWeight: 500,
          color: 'var(--t-text-secondary)',
          letterSpacing: '-0.005em',
          whiteSpace: 'nowrap',
        }}>
          Drawing context
        </span>
        <span style={{
          fontSize: 11,
          fontWeight: 400,
          color: 'var(--t-text-faint)',
          letterSpacing: '-0.005em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
          flex: 1,
        }}>
          {context.regionLabel}
          {context.elementCount > 0 ? ` · ${context.elementCount} element${context.elementCount === 1 ? '' : 's'}` : ''}
        </span>
        <Chevron size={12} strokeWidth={1.8} style={{ color: 'var(--t-text-faint)', flexShrink: 0 }} />
      </button>
      {expanded ? (
        <div style={{
          paddingTop: 0,
          paddingRight: 12,
          paddingBottom: 9,
          paddingLeft: 31,
          fontSize: 10.5,
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          color: 'var(--t-text-secondary)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          lineHeight: 1.55,
        }}>
          {context.detail}
        </div>
      ) : null}
    </div>
  );
}
