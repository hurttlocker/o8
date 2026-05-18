'use client';

/**
 * ToolCallChip — a one-line, compact representation of an in-flight or
 * completed Coordinator tool call. Used by both LivingAgentPanel
 * (#890) and the inline-chat tool-call cluster (#894).
 *
 * Rules:
 *  - Slide-in with a 100ms fade only — no bounce, no scale.
 *  - prefers-reduced-motion: skip animation.
 *  - Pure inline styles. No CSS classes. Theme tokens for surfaces.
 *  - One orange accent per "running" chip — done chips are ink-on-paper.
 *  - No emoji — raw inline SVG glyphs only.
 */

import { memo, useEffect, useState } from 'react';

export type ToolCallChipStatus = 'running' | 'done' | 'error';

export interface ToolCallChipProps {
  /** Verb shown left of the colon (e.g. "Read", "Delegate", "Write"). */
  verb: string;
  /** Argument shown right of the colon, truncated by caller if long. */
  argument?: string | null;
  /** Optional kind for icon selection ('read' | 'write' | 'delegate' | 'spec'). */
  kind?: 'read' | 'write' | 'delegate' | 'spec' | 'shell' | 'generic';
  status?: ToolCallChipStatus;
  /** Optional click handler for an expansion popover (#894). */
  onClick?: () => void;
}

function ToolCallChipBase({ verb, argument, kind = 'generic', status = 'done', onClick }: ToolCallChipProps) {
  // Read prefers-reduced-motion once at mount as initializer. This avoids
  // the react-hooks/set-state-in-effect lint rule and keeps a stable
  // value across renders since the media query is read on first paint.
  const [reducedMotion] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  });
  const [mounted, setMounted] = useState<boolean>(reducedMotion);

  useEffect(() => {
    if (reducedMotion) return;
    if (typeof window === 'undefined') return;
    const t = window.setTimeout(() => setMounted(true), 0);
    return () => window.clearTimeout(t);
  }, [reducedMotion]);

  const accent = status === 'running' ? '#FF5A1F' : status === 'error' ? 'var(--t-brand-red, #ef4444)' : 'var(--t-text-muted)';
  const textColor = status === 'running' ? 'var(--t-text)' : 'var(--t-text-secondary)';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 22,
        paddingTop: 0,
        paddingRight: 8,
        paddingBottom: 0,
        paddingLeft: 8,
        borderRadius: 6,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider-subtle)',
        background: 'var(--t-bg-card)',
        color: textColor,
        cursor: onClick ? 'pointer' : 'default',
        fontFamily: 'var(--font-sans-system)',
        fontSize: 10.5,
        fontWeight: 500,
        letterSpacing: '-0.005em',
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateX(0)' : 'translateX(-4px)',
        transition: reducedMotion
          ? 'none'
          : 'opacity 100ms cubic-bezier(0.22, 1, 0.36, 1), transform 100ms cubic-bezier(0.22, 1, 0.36, 1)',
        maxWidth: '100%',
      }}
    >
      <ToolCallGlyph kind={kind} accent={accent} />
      <span
        style={{
          fontWeight: 600,
          color: status === 'running' ? accent : 'var(--t-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          fontSize: 9,
          flexShrink: 0,
        }}
      >
        {verb}
      </span>
      {argument ? (
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
            fontSize: 10,
            color: 'var(--t-text-secondary)',
          }}
        >
          {argument}
        </span>
      ) : null}
    </button>
  );
}

function ToolCallGlyph({ kind, accent }: { kind: ToolCallChipProps['kind']; accent: string }) {
  const stroke = accent;
  const common = {
    width: 11,
    height: 11,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke,
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    style: { flexShrink: 0, display: 'block' as const },
  };
  switch (kind) {
    case 'read':
      return (
        <svg {...common}>
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
        </svg>
      );
    case 'write':
      return (
        <svg {...common}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
        </svg>
      );
    case 'delegate':
      return (
        <svg {...common}>
          <path d="M5 12h14" />
          <path d="m13 6 6 6-6 6" />
        </svg>
      );
    case 'spec':
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M9 13h6" />
          <path d="M9 17h6" />
        </svg>
      );
    case 'shell':
      return (
        <svg {...common}>
          <path d="m4 17 6-6-6-6" />
          <path d="M12 19h8" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
  }
}

export const ToolCallChip = memo(ToolCallChipBase);

/** Heuristic mapping from raw tool name → visible verb + glyph kind. */
export function classifyToolCall(toolName: string): { verb: string; kind: ToolCallChipProps['kind'] } {
  const lc = toolName.toLowerCase();
  if (lc.includes('read') || lc === 'read' || lc.includes('cat') || lc === 'view') {
    return { verb: 'Read', kind: 'read' };
  }
  if (lc.includes('write') || lc === 'edit' || lc === 'multiedit' || lc.includes('apply')) {
    return { verb: 'Write', kind: 'write' };
  }
  if (lc.includes('dispatch') || lc.includes('delegate') || lc.includes('spawn') || lc === 'task') {
    return { verb: 'Delegate', kind: 'delegate' };
  }
  if (lc.includes('spec')) {
    return { verb: 'Spec', kind: 'spec' };
  }
  if (lc.includes('bash') || lc.includes('shell') || lc.includes('exec') || lc.includes('run')) {
    return { verb: 'Run', kind: 'shell' };
  }
  return { verb: toolName.length > 12 ? `${toolName.slice(0, 12)}…` : toolName, kind: 'generic' };
}
