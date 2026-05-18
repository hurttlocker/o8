/**
 * Inline style tokens for the Cmd+K CommandPalette overlay (#661).
 *
 * Pulled out of CommandPalette.tsx to keep that file under the 800-line
 * ceiling while preserving the inline-style discipline (no CSS classes).
 */

import type { CSSProperties } from 'react';

export const KIND_COLOR = {
  issue: '#f97316',
  file: '#64748b',
  agent: '#16a34a',
} as const;

export const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  paddingTop: '12vh',
  paddingLeft: 16,
  paddingRight: 16,
  paddingBottom: 24,
  background: 'var(--t-overlay-scrim, rgba(15, 23, 42, 0.32))',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
  zIndex: 1200,
};

export const cardStyle: CSSProperties = {
  width: '100%',
  maxWidth: 640,
  borderRadius: 14,
  border: '1px solid var(--t-panel-border)',
  background: 'var(--t-glass-elevated, var(--t-panel-solid, var(--t-panel)))',
  boxShadow: 'var(--t-glass-shadow, 0 24px 64px rgba(15, 23, 42, 0.18))',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  fontFamily: 'var(--font-sans-system)',
  letterSpacing: '-0.01em',
  color: 'var(--t-text)',
};

export const inputRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  paddingTop: 14,
  paddingRight: 14,
  paddingBottom: 12,
  paddingLeft: 16,
  borderBottom: '1px solid var(--t-divider, var(--t-border))',
};

export const inputStyle: CSSProperties = {
  flex: 1,
  border: 'none',
  background: 'transparent',
  outline: 'none',
  fontSize: 15,
  fontWeight: 400,
  letterSpacing: '-0.01em',
  color: 'var(--t-text)',
  fontFamily: 'inherit',
  WebkitAppearance: 'none',
  minWidth: 0,
};

export const clearButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 22,
  height: 22,
  border: 'none',
  background: 'var(--t-hover)',
  borderRadius: 8,
  cursor: 'pointer',
};

export const kbdStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  fontFamily: 'var(--font-sans-system)',
  color: 'var(--t-kbd-color, var(--t-text-muted))',
  background: 'var(--t-kbd-bg, var(--t-bg-card))',
  border: '1px solid var(--t-kbd-border, var(--t-border))',
  borderRadius: 6,
  paddingTop: 2,
  paddingRight: 6,
  paddingBottom: 2,
  paddingLeft: 6,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

export const listStyle: CSSProperties = {
  flex: 1,
  maxHeight: '52vh',
  overflowY: 'auto',
  WebkitOverflowScrolling: 'touch',
  paddingTop: 6,
  paddingBottom: 6,
};

export const sectionHeaderStyle: CSSProperties = {
  paddingTop: 10,
  paddingRight: 16,
  paddingBottom: 4,
  paddingLeft: 16,
  fontSize: 10,
  fontWeight: 600,
  color: 'var(--t-text-faint)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
};

export const rowStyleBase: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  paddingTop: 8,
  paddingRight: 12,
  paddingBottom: 8,
  paddingLeft: 16,
  border: 'none',
  borderRadius: 10,
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'inherit',
  color: 'var(--t-text)',
  minHeight: 44,
  transition: 'background 80ms cubic-bezier(0.22, 1, 0.36, 1)',
};

export const iconWrapStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 18,
  flexShrink: 0,
  color: 'var(--t-text-muted)',
};

export const titleColumnStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  gap: 2,
};

export const titleTextStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--t-text)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const detailTextStyle: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--t-text-faint)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontWeight: 400,
};

export type GroupKey = 'recent' | 'issue' | 'file' | 'agent' | 'action';

export function groupBadgeStyle(group: GroupKey): CSSProperties {
  const tone = group === 'recent'
    ? 'var(--t-text-faint)'
    : group === 'action'
      ? 'var(--t-text-muted)'
      : KIND_COLOR[group];
  return {
    fontSize: 10,
    fontWeight: 600,
    color: tone,
    paddingTop: 2,
    paddingRight: 6,
    paddingBottom: 2,
    paddingLeft: 6,
    borderRadius: 6,
    background: 'transparent',
    border: '1px solid color-mix(in srgb, var(--t-border) 80%, transparent)',
    flexShrink: 0,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  };
}

export const errorRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  paddingTop: 10,
  paddingRight: 16,
  paddingBottom: 10,
  paddingLeft: 16,
  fontSize: 12,
  color: 'var(--t-danger, #b91c1c)',
};

export const statusRowStyle: CSSProperties = {
  paddingTop: 16,
  paddingRight: 16,
  paddingBottom: 16,
  paddingLeft: 16,
  fontSize: 12,
  color: 'var(--t-text-muted)',
};

export const footerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  paddingTop: 8,
  paddingRight: 14,
  paddingBottom: 8,
  paddingLeft: 16,
  borderTop: '1px solid var(--t-divider, var(--t-border))',
  background: 'var(--t-bg-subtle, transparent)',
  fontSize: 11,
  color: 'var(--t-text-muted)',
};

export const footerHintGroupStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
};

export const footerHintTextStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 11,
  color: 'var(--t-text-muted)',
  fontWeight: 500,
};

export const footerSpacerStyle: CSSProperties = {
  flex: 1,
};

export const footerKbdStyle: CSSProperties = {
  ...kbdStyle,
  fontSize: 9,
  paddingLeft: 5,
  paddingRight: 5,
};
