'use client';

/**
 * /context-graph — shared primitives.
 *
 * Locked to the light glass aesthetic from DESIGN.md §01.
 * Every value here is referenced by /context-graph/page.tsx and its
 * three column files. Keep this thin — no logic, just the editorial
 * vocabulary the graph figure needs (labels, dots, hairlines, palette
 * fallbacks for the page that runs outside ThemeProvider).
 *
 * Why we hardcode some values: the page is screenshot-bait for the
 * pitch deck. It must render correctly even if it's loaded outside
 * the dashboard's ThemeProvider mount, so the page root injects the
 * full --t-* token set inline. These constants mirror the light
 * theme entries from src/lib/theme/themes.ts (do not drift from there).
 */

import type { CSSProperties } from 'react';

// ---------------------------------------------------------------------------
// Light-theme token mirror (from src/lib/theme/themes.ts → themes[0]).
// Inlined as a CSS-property bag so the page can self-style without a
// ThemeProvider mount. If you change values here, update the source theme
// too and vice-versa.
// ---------------------------------------------------------------------------
export const LIGHT_THEME_VARS: CSSProperties = {
  // chrome
  ['--t-panel' as string]: 'rgba(244, 242, 237, 0.58)',
  ['--t-panel-border' as string]: 'rgba(15, 23, 42, 0.1)',
  ['--t-bg' as string]: 'rgba(244, 242, 237, 0.62)',
  ['--t-bg-card' as string]: 'rgba(15, 23, 42, 0.04)',
  ['--t-border' as string]: 'rgba(15, 23, 42, 0.1)',
  ['--t-divider' as string]: 'rgba(15, 23, 42, 0.08)',
  ['--t-divider-subtle' as string]: 'rgba(15, 23, 42, 0.05)',
  // text
  ['--t-text' as string]: '#0f172a',
  ['--t-text-strong' as string]: '#020617',
  ['--t-text-secondary' as string]: '#475569',
  ['--t-text-muted' as string]: '#64748b',
  ['--t-text-faint' as string]: '#94a3b8',
  // accent (we override with brand orange where the figure needs it)
  ['--t-accent' as string]: '#2563eb',
  ['--t-canvas-bg' as string]: '#F4F2ED',
};

// The page's "paper" tone (matches --t-canvas-bg).
export const PAPER = '#F4F2ED';
// The brand orange — used ONLY for highlighted graph nodes per the spec.
export const BRAND_ORANGE = '#ef4444';

export const FONT_SANS =
  '"Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
export const FONT_MONO =
  'var(--font-mono, "SF Mono"), Menlo, Consolas, "Liberation Mono", monospace';

// ---------------------------------------------------------------------------
// SectionLabel — bracketed wide-tracked label above each column.
//   `[REALTIME RAW CONTEXT]`
// ---------------------------------------------------------------------------
export function SectionLabel({ children }: { children: string }) {
  return (
    <div
      style={{
        fontFamily: FONT_MONO,
        fontSize: '11px',
        fontWeight: 500,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: 'var(--t-text-muted)',
        whiteSpace: 'nowrap',
      }}
    >
      [{children}]
    </div>
  );
}

// ---------------------------------------------------------------------------
// NumberedHeading — "01 — Realtime Raw Context" rhythm under the label.
// ---------------------------------------------------------------------------
export function NumberedHeading({
  index,
  title,
}: {
  index: string;
  title: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: '12px',
        marginTop: '14px',
      }}
    >
      <span
        style={{
          fontFamily: FONT_MONO,
          fontSize: '13px',
          fontWeight: 500,
          color: 'var(--t-text-faint)',
          letterSpacing: '0.04em',
        }}
      >
        {index}
      </span>
      <span
        style={{
          fontFamily: FONT_SANS,
          fontSize: '15px',
          fontWeight: 500,
          color: 'var(--t-text-strong)',
          letterSpacing: '-0.012em',
        }}
      >
        {title}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IntensityDots — 4 dots, monospace, gradient from muted → ink.
//   intensity = 0..4 (how many dots are "lit")
// ---------------------------------------------------------------------------
export function IntensityDots({ intensity }: { intensity: number }) {
  const clamped = Math.max(0, Math.min(4, intensity));
  // Each lit dot gets a step closer to ink. Unlit dots stay faint.
  const dotColor = (i: number) => {
    if (i >= clamped) return 'rgba(15, 23, 42, 0.16)';
    // Lit: stepped from muted (faint) → ink (full)
    const stops = [
      'rgba(15, 23, 42, 0.42)',
      'rgba(15, 23, 42, 0.58)',
      'rgba(15, 23, 42, 0.76)',
      '#0f172a',
    ];
    return stops[i];
  };

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        fontFamily: FONT_MONO,
        fontSize: '11px',
        letterSpacing: '0.08em',
      }}
      aria-hidden
    >
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          style={{
            display: 'inline-block',
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: dotColor(i),
          }}
        />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// HairlineDivider — 1px at 8% opacity, the only acceptable separator.
// ---------------------------------------------------------------------------
export function HairlineDivider({ vertical = false }: { vertical?: boolean }) {
  if (vertical) {
    return (
      <div
        style={{
          width: '1px',
          alignSelf: 'stretch',
          background: 'var(--t-divider)',
        }}
      />
    );
  }
  return (
    <div
      style={{
        height: '1px',
        background: 'var(--t-divider)',
        width: '100%',
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// SourceRow — left-column row: label + intensity dots.
// ---------------------------------------------------------------------------
export function SourceRow({
  label,
  intensity,
  detail,
}: {
  label: string;
  intensity: number;
  detail: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        paddingTop: '14px',
        paddingBottom: '14px',
        borderBottom: '1px solid var(--t-divider-subtle)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: '12px',
        }}
      >
        <span
          style={{
            fontFamily: FONT_SANS,
            fontSize: '13px',
            fontWeight: 500,
            color: 'var(--t-text)',
            letterSpacing: '-0.01em',
          }}
        >
          {label}
        </span>
        <IntensityDots intensity={intensity} />
      </div>
      <span
        style={{
          fontFamily: FONT_MONO,
          fontSize: '10.5px',
          fontWeight: 400,
          color: 'var(--t-text-muted)',
          letterSpacing: '0.01em',
          lineHeight: 1.5,
        }}
      >
        {detail}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CuratedRow — right-column row: numbered output products.
// ---------------------------------------------------------------------------
export function CuratedRow({
  index,
  title,
  blurb,
}: {
  index: string;
  title: string;
  blurb: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        paddingTop: '14px',
        paddingBottom: '14px',
        borderBottom: '1px solid var(--t-divider-subtle)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: '10px',
        }}
      >
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: '11px',
            fontWeight: 500,
            color: 'var(--t-text-faint)',
            letterSpacing: '0.04em',
          }}
        >
          {index}
        </span>
        <span
          style={{
            fontFamily: FONT_SANS,
            fontSize: '13px',
            fontWeight: 500,
            color: 'var(--t-text)',
            letterSpacing: '-0.01em',
          }}
        >
          {title}
        </span>
      </div>
      <span
        style={{
          fontFamily: FONT_SANS,
          fontSize: '12px',
          fontWeight: 400,
          color: 'var(--t-text-muted)',
          lineHeight: 1.55,
          letterSpacing: '-0.005em',
        }}
      >
        {blurb}
      </span>
    </div>
  );
}
