'use client';

/**
 * Inset-grouped settings primitives — the o8-mobile settings system ported to
 * desktop (epic #1450). Apple Settings grouping (uppercase section header →
 * inset rounded card → icon-tile rows with trailing accessories + label-inset
 * dividers) on o8's paper/ink tokens. Selection stays monochrome — alpha-gray
 * fills and hairlines; hue is reserved for destructive.
 */

import { useState } from 'react';
import { APP_FONT_STACK, RAMS_INK_QUIET, SettingsToggleButton } from './shared';

// Geometry (desktop adaptation of the o8-mobile values; hurttlocker.md governs)
const GROUP_RADIUS = 14;
const ICON_TILE = 28;
const ROW_MIN_HEIGHT = 48;
const ROW_PAD_H = 14;
const ROW_GAP = 12;
const DIVIDER_INSET = ROW_PAD_H + ICON_TILE + ROW_GAP; // divider starts under the label

const TILE_BG = 'rgba(128, 128, 128, 0.14)';
const TILE_BG_DESTRUCTIVE = 'rgba(255, 69, 58, 0.15)';
const DESTRUCTIVE = '#d94f3a';

export function GroupHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: APP_FONT_STACK,
      fontSize: 10,
      fontWeight: 400,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: RAMS_INK_QUIET,
      paddingLeft: ROW_PAD_H + 2,
      paddingBottom: 7,
      userSelect: 'none',
    }}>
      {children}
    </div>
  );
}

export function GroupFootnote({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: APP_FONT_STACK,
      fontSize: 12,
      fontWeight: 300,
      color: 'var(--t-text-faint)',
      lineHeight: 1.5,
      paddingLeft: ROW_PAD_H + 2,
      paddingRight: ROW_PAD_H,
      paddingTop: 7,
      maxWidth: 560,
    }}>
      {children}
    </div>
  );
}

export function SettingsGroup({
  header,
  footnote,
  children,
  maxWidth = 620,
}: {
  header?: React.ReactNode;
  footnote?: React.ReactNode;
  children: React.ReactNode;
  maxWidth?: number;
}) {
  return (
    <div style={{ maxWidth }}>
      {header ? <GroupHeader>{header}</GroupHeader> : null}
      <div style={{
        borderRadius: GROUP_RADIUS,
        border: '1px solid var(--t-panel-border)',
        background: 'var(--t-bg-card)',
        overflow: 'hidden',
      }}>
        {children}
      </div>
      {footnote ? <GroupFootnote>{footnote}</GroupFootnote> : null}
    </div>
  );
}

export function RowDivider() {
  return (
    <div aria-hidden style={{
      height: 1,
      background: 'var(--t-divider, rgba(17,17,17,0.06))',
      marginLeft: DIVIDER_INSET,
    }} />
  );
}

function IconTile({ icon, destructive }: { icon: React.ReactNode; destructive?: boolean }) {
  return (
    <span style={{
      width: ICON_TILE,
      height: ICON_TILE,
      borderRadius: 8,
      background: destructive ? TILE_BG_DESTRUCTIVE : TILE_BG,
      color: destructive ? DESTRUCTIVE : 'var(--t-text-secondary)',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
      opacity: destructive ? 1 : 0.9,
    }}>
      {icon}
    </span>
  );
}

export function ValuePill({ children, tone = 'default' }: { children: React.ReactNode; tone?: 'default' | 'success' | 'destructive' }) {
  return (
    <span style={{
      fontFamily: APP_FONT_STACK,
      fontSize: 11.5,
      fontWeight: 400,
      color: tone === 'destructive' ? DESTRUCTIVE : tone === 'success' ? '#1a7f4b' : 'var(--t-text-secondary)',
      background: tone === 'destructive' ? TILE_BG_DESTRUCTIVE : tone === 'success' ? 'rgba(34, 197, 94, 0.14)' : TILE_BG,
      borderRadius: 999,
      paddingLeft: 10,
      paddingRight: 10,
      paddingTop: 3,
      paddingBottom: 3,
      whiteSpace: 'nowrap',
      flexShrink: 0,
    }}>
      {children}
    </span>
  );
}

function Chevron() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      style={{ display: 'block', flexShrink: 0, color: RAMS_INK_QUIET, opacity: 0.6 }}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

/**
 * One grouped row. Renders as a <button> when onPress is given (press-scale
 * physics), otherwise a plain <div>. Trailing accessory precedence:
 * switch (checked+onToggle) → custom accessory → value text/pill. chevron adds
 * the drill-in caret after the accessory.
 */
export function SettingsRow({
  icon,
  label,
  subtitle,
  value,
  pill,
  accessory,
  checked,
  onToggle,
  onPress,
  chevron = false,
  ariaExpanded,
  destructive = false,
  disabled = false,
  divider = false,
}: {
  icon?: React.ReactNode;
  label: React.ReactNode;
  subtitle?: React.ReactNode;
  value?: React.ReactNode;
  pill?: boolean;
  accessory?: React.ReactNode;
  checked?: boolean;
  onToggle?: (next: boolean) => void;
  onPress?: () => void;
  chevron?: boolean;
  ariaExpanded?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  divider?: boolean;
}) {
  const [pressed, setPressed] = useState(false);
  const isSwitch = typeof checked === 'boolean' && !!onToggle;
  const clickable = !!onPress && !disabled;

  const body = (
    <>
      {icon ? <IconTile icon={icon} destructive={destructive} /> : null}
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1, textAlign: 'left' }}>
        <span style={{
          fontFamily: APP_FONT_STACK,
          fontSize: 13.5,
          fontWeight: 400,
          letterSpacing: '-0.01em',
          color: destructive ? DESTRUCTIVE : 'var(--t-text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {label}
        </span>
        {subtitle ? (
          <span style={{
            fontFamily: APP_FONT_STACK,
            fontSize: 11.5,
            fontWeight: 300,
            color: 'var(--t-text-faint)',
            lineHeight: 1.4,
          }}>
            {subtitle}
          </span>
        ) : null}
      </span>
      {isSwitch ? (
        <SettingsToggleButton checked={checked!} onChange={onToggle!} disabled={disabled} />
      ) : accessory ? (
        accessory
      ) : value != null ? (
        pill ? <ValuePill>{value}</ValuePill> : (
          <span style={{
            fontFamily: APP_FONT_STACK,
            fontSize: 12.5,
            fontWeight: 300,
            color: 'var(--t-text-secondary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: 240,
          }}>
            {value}
          </span>
        )
      ) : null}
      {chevron ? <Chevron /> : null}
    </>
  );

  const baseStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: ROW_GAP,
    width: '100%',
    minHeight: ROW_MIN_HEIGHT,
    paddingLeft: ROW_PAD_H,
    paddingRight: ROW_PAD_H,
    paddingTop: 8,
    paddingBottom: 8,
    background: pressed ? TILE_BG : 'transparent',
    border: 'none',
    fontFamily: APP_FONT_STACK,
    opacity: disabled ? 0.45 : 1,
    transform: pressed ? 'scale(0.985)' : 'scale(1)',
    transition: 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1), background 160ms ease',
  };

  const row = clickable ? (
    <button
      type="button"
      aria-expanded={ariaExpanded}
      onClick={onPress}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onMouseLeave={() => setPressed(false)}
      style={{ ...baseStyle, cursor: 'pointer' }}
    >
      {body}
    </button>
  ) : (
    <div style={baseStyle}>{body}</div>
  );

  return (
    <>
      {row}
      {divider ? <RowDivider /> : null}
    </>
  );
}
