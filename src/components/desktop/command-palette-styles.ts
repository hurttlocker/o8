import type { CSSProperties } from 'react';

export type GroupKey =
  | 'recent'
  | 'issue'
  | 'file'
  | 'agent'
  | 'chat'
  | 'transcript'
  | 'approval'
  | 'inbox'
  | 'directive'
  | 'action';

export const overlayStyle: CSSProperties = {
  position: 'fixed',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  zIndex: 1200,
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  paddingTop: '12vh',
  paddingRight: 16,
  paddingBottom: 24,
  paddingLeft: 16,
  background: 'var(--t-overlay-scrim)',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
};

export const cardStyle: CSSProperties = {
  width: '100%',
  maxWidth: 640,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--t-panel-border)',
  borderRadius: 14,
  background: 'var(--t-glass-elevated, var(--t-panel-solid, var(--t-panel)))',
  boxShadow: 'var(--t-glass-shadow)',
  color: 'var(--t-text)',
  fontFamily: 'var(--font-sans-system)',
  letterSpacing: '-0.1px',
};

export const inputRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  paddingTop: 14,
  paddingRight: 14,
  paddingBottom: 10,
  paddingLeft: 16,
};

export const inputStyle: CSSProperties = {
  minWidth: 0,
  flex: 1,
  borderWidth: 0,
  background: 'transparent',
  outline: 'none',
  color: 'var(--t-text)',
  fontSize: 15,
  fontWeight: 300,
  letterSpacing: '-0.1px',
  fontFamily: 'inherit',
  WebkitAppearance: 'none',
};

export const clearButtonStyle: CSSProperties = {
  width: 22,
  height: 22,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  paddingTop: 0,
  paddingRight: 0,
  paddingBottom: 0,
  paddingLeft: 0,
  borderWidth: 0,
  borderRadius: 7,
  background: 'var(--t-hover)',
  color: 'var(--t-text-muted)',
  cursor: 'pointer',
};

export const kbdStyle: CSSProperties = {
  paddingTop: 2,
  paddingRight: 6,
  paddingBottom: 2,
  paddingLeft: 6,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--t-kbd-border, var(--t-divider))',
  borderRadius: 6,
  background: 'var(--t-kbd-bg, var(--t-bg-card))',
  color: 'var(--t-kbd-color, var(--t-text-muted))',
  fontSize: 9.5,
  fontWeight: 300,
  letterSpacing: '0.04em',
  lineHeight: 1.25,
  fontFamily: 'var(--font-sans-system)',
  textTransform: 'uppercase',
};

export const scopeRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  overflowX: 'auto',
  paddingTop: 0,
  paddingRight: 10,
  paddingBottom: 8,
  paddingLeft: 10,
  borderBottomWidth: 1,
  borderBottomStyle: 'solid',
  borderBottomColor: 'var(--t-divider)',
};

export function scopePillStyle(active: boolean): CSSProperties {
  return {
    height: 26,
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    paddingTop: 0,
    paddingRight: 10,
    paddingBottom: 0,
    paddingLeft: 10,
    borderWidth: 0,
    borderRadius: 7,
    background: active ? 'var(--t-input-bg)' : 'transparent',
    color: active ? 'var(--t-text)' : 'var(--t-text-muted)',
    fontSize: 12,
    fontWeight: 300,
    letterSpacing: '-0.1px',
    lineHeight: 1.25,
    fontFamily: 'var(--font-sans-system)',
    cursor: 'pointer',
  };
}

export const listStyle: CSSProperties = {
  maxHeight: '52vh',
  flex: 1,
  overflowY: 'auto',
  paddingTop: 6,
  paddingRight: 6,
  paddingBottom: 6,
  paddingLeft: 6,
  WebkitOverflowScrolling: 'touch',
};

export const sectionHeaderStyle: CSSProperties = {
  paddingTop: 9,
  paddingRight: 10,
  paddingBottom: 4,
  paddingLeft: 10,
  color: 'var(--t-text-faint)',
  fontSize: 10,
  fontWeight: 300,
  letterSpacing: '0.04em',
  lineHeight: '14px',
  textTransform: 'uppercase',
};

export const rowStyleBase: CSSProperties = {
  width: '100%',
  minHeight: 38,
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  paddingTop: 6,
  paddingRight: 10,
  paddingBottom: 6,
  paddingLeft: 10,
  borderWidth: 0,
  borderRadius: 8,
  color: 'var(--t-text)',
  fontFamily: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  transition: 'background 80ms ease',
};

export const iconWrapStyle: CSSProperties = {
  width: 18,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  color: 'var(--t-text-muted)',
};

export const titleTextStyle: CSSProperties = {
  minWidth: 0,
  flex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--t-text)',
  fontSize: 13.5,
  fontWeight: 300,
  letterSpacing: '-0.1px',
  lineHeight: 1.25,
};

export const metaTextStyle: CSSProperties = {
  maxWidth: '44%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flexShrink: 1,
  color: 'var(--t-text-faint)',
  fontSize: 9.5,
  fontWeight: 260,
  letterSpacing: '-0.4px',
  lineHeight: 1.25,
  textAlign: 'right',
};

export const enterHintStyle: CSSProperties = {
  width: 16,
  flexShrink: 0,
  color: 'var(--t-text-faint)',
  fontSize: 11,
  fontWeight: 300,
  lineHeight: 1,
  textAlign: 'right',
};

export const errorRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  paddingTop: 10,
  paddingRight: 10,
  paddingBottom: 10,
  paddingLeft: 10,
  color: 'var(--t-brand-red)',
  fontSize: 12,
  fontWeight: 300,
};

export const statusRowStyle: CSSProperties = {
  paddingTop: 16,
  paddingRight: 10,
  paddingBottom: 16,
  paddingLeft: 10,
  color: 'var(--t-text-muted)',
  fontSize: 12,
  fontWeight: 300,
};

export const footerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 14,
  paddingTop: 7,
  paddingRight: 12,
  paddingBottom: 7,
  paddingLeft: 12,
  borderTopWidth: 1,
  borderTopStyle: 'solid',
  borderTopColor: 'var(--t-divider)',
  background: 'var(--t-bg-subtle, transparent)',
  color: 'var(--t-text-faint)',
  fontSize: 9.5,
  fontWeight: 260,
  letterSpacing: '-0.4px',
  lineHeight: 1.25,
};
