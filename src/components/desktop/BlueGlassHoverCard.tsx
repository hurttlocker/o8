'use client';

import { createPortal } from 'react-dom';
import type { CSSProperties, ReactNode } from 'react';

function resolveFloatingPosition(anchorRect: DOMRect, width: number) {
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1440;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 900;
  const margin = 16;

  let left = anchorRect.right + 14;
  if (left + width + margin > viewportWidth) {
    left = Math.max(margin, anchorRect.left - width - 14);
  }

  let top = anchorRect.top;
  const estimatedHeight = 260;
  if (top + estimatedHeight + margin > viewportHeight) {
    top = Math.max(margin, viewportHeight - estimatedHeight - margin);
  }

  return { left, top };
}

export function BlueGlassHoverCard({
  title,
  eyebrow,
  subtitle,
  footer,
  children,
  width = 340,
  style,
  anchorRect,
  interactive = false,
  onMouseEnter,
  onMouseLeave,
}: {
  title: string;
  eyebrow?: string;
  subtitle?: string;
  footer?: ReactNode;
  children?: ReactNode;
  width?: number;
  style?: CSSProperties;
  anchorRect?: DOMRect | null;
  interactive?: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const content = (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: anchorRect ? 'fixed' : 'absolute',
        zIndex: 10000,
        width,
        padding: '14px 15px 13px',
        borderRadius: 18,
        border: '1px solid var(--t-panel-border)',
        background: 'var(--t-panel-solid)',
        backdropFilter: 'none',
        WebkitBackdropFilter: 'none',
        boxShadow: 'var(--t-panel-shadow), 0 8px 32px rgba(15, 23, 42, 0.18)',
        color: 'var(--t-text)',
        pointerEvents: interactive ? 'auto' : 'none',
        ...(anchorRect ? resolveFloatingPosition(anchorRect, width) : null),
        ...style,
      }}
    >
      {eyebrow ? (
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.11em',
            textTransform: 'uppercase',
            color: 'var(--t-accent, #2563eb)',
            marginBottom: 6,
          }}
        >
          {eyebrow}
        </div>
      ) : null}
      <div
        style={{
          fontSize: 14,
          fontWeight: 700,
          letterSpacing: '-0.02em',
          color: 'var(--t-text)',
        }}
      >
        {title}
      </div>
      {subtitle ? (
        <div
          style={{
            marginTop: 5,
            fontSize: 12,
            lineHeight: 1.5,
            color: 'var(--t-text-secondary)',
          }}
        >
          {subtitle}
        </div>
      ) : null}
      {children ? (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {children}
        </div>
      ) : null}
      {footer ? (
        <div
          style={{
            marginTop: 12,
            paddingTop: 10,
            borderTop: '1px solid var(--t-divider-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          {footer}
        </div>
      ) : null}
    </div>
  );

  if (anchorRect && typeof document !== 'undefined') {
    return createPortal(content, document.body);
  }

  return content;
}

export function BlueGlassActionButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        border: '1px solid var(--t-accent-border, rgba(37, 99, 235, 0.22))',
        background: 'var(--t-panel-hover)',
        color: 'var(--t-text)',
        padding: '7px 11px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        cursor: 'pointer',
        boxShadow: '0 8px 18px rgba(15, 23, 42, 0.12)',
      }}
    >
      {icon}
      {label}
    </button>
  );
}

export function BlueGlassMetricPill({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 6,
        padding: '5px 9px',
        borderRadius: 999,
        background: 'var(--t-panel-hover)',
        border: '1px solid var(--t-panel-border)',
      }}
    >
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t-text-muted)' }}>
        {label}
      </span>
      <span style={{ fontSize: 11, fontWeight: 800, color }}>{value}</span>
    </div>
  );
}

export function BlueGlassSparklineLane({
  segments,
}: {
  segments: Array<{ label: string; value: number; color: string }>;
}) {
  const maxValue = Math.max(1, ...segments.map((segment) => segment.value));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'end', gap: 5, height: 34 }}>
        {segments.map((segment) => (
          <div key={segment.label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, minWidth: 28 }}>
            <div
              style={{
                width: 20,
                height: Math.max(6, Math.round((segment.value / maxValue) * 28)),
                borderRadius: 999,
                background: `linear-gradient(180deg, ${segment.color}, ${segment.color}99)`,
                boxShadow: `0 8px 18px ${segment.color}33`,
              }}
            />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {segments.map((segment) => (
          <div key={`${segment.label}-legend`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--t-text-secondary)' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: segment.color, display: 'inline-block' }} />
            <span>{segment.label}</span>
            <span style={{ fontWeight: 700, color: 'var(--t-text)' }}>{segment.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
