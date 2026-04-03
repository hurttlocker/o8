'use client';

import { ThreadListPrimitive, ThreadPrimitive } from '@assistant-ui/react';
import type { CSSProperties, ReactNode } from 'react';
import {
  MOBILE_BODY_TRACKING,
  MOBILE_CARD_RADIUS,
  MOBILE_GLASS_BLUR,
  MOBILE_HEADING_TRACKING,
  MOBILE_TOUCH_TARGET,
  mobileCardStyle,
  mobileFontFamily,
  type MobilePalette,
} from './mobile-approvals-shared';

export function mobileSafeBottom(extra = 20) {
  return `calc(env(safe-area-inset-bottom, 0px) + ${extra}px)`;
}

export function MobileSurfaceRoot({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <ThreadPrimitive.Root
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        letterSpacing: MOBILE_BODY_TRACKING,
        ...style,
      }}
    >
      {children}
    </ThreadPrimitive.Root>
  );
}

export function MobileGlassPanel({
  children,
  palette,
  style,
}: {
  children: ReactNode;
  palette: MobilePalette;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        ...mobileCardStyle(palette, {
          background: palette.panelElevated,
        }),
        backdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
        WebkitBackdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function MobileThreadListRoot({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <ThreadListPrimitive.Root
      style={{
        display: 'grid',
        gap: 12,
        ...style,
      }}
    >
      {children}
    </ThreadListPrimitive.Root>
  );
}

export function MobileSectionHeading({
  eyebrow,
  title,
  subtitle,
  palette,
  action,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  palette: MobilePalette;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
      }}
    >
      <div style={{ minWidth: 0 }}>
        {eyebrow ? (
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: palette.subduedText,
              marginBottom: 6,
            }}
          >
            {eyebrow}
          </div>
        ) : null}
        <div
          style={{
            fontSize: 24,
            fontWeight: 800,
            letterSpacing: MOBILE_HEADING_TRACKING,
            color: palette.rootText,
            lineHeight: 1.05,
          }}
        >
          {title}
        </div>
        {subtitle ? (
          <div
            style={{
              fontSize: 13,
              color: palette.subduedText,
              lineHeight: 1.6,
              letterSpacing: MOBILE_BODY_TRACKING,
              marginTop: 8,
            }}
          >
            {subtitle}
          </div>
        ) : null}
      </div>
      {action ? <div style={{ flexShrink: 0 }}>{action}</div> : null}
    </div>
  );
}

export function MobileMetricChip({
  label,
  value,
  palette,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  palette: MobilePalette;
  tone?: 'neutral' | 'accent' | 'success' | 'danger';
}) {
  const background = tone === 'accent'
    ? palette.accentSoft
    : tone === 'success'
      ? palette.successSoft
      : tone === 'danger'
        ? palette.dangerSoft
        : palette.cardBackground;
  const border = tone === 'accent'
    ? palette.accentBorder
    : tone === 'success'
      ? palette.successBorder
      : tone === 'danger'
        ? palette.dangerBorder
        : palette.cardBorder;

  return (
    <div
      style={{
        borderRadius: MOBILE_CARD_RADIUS,
        border: `1px solid ${border}`,
        background,
        padding: '12px 14px',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: palette.subduedText,
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 15,
          fontWeight: 700,
          color: palette.rootText,
          letterSpacing: MOBILE_BODY_TRACKING,
        }}
      >
        {value}
      </div>
    </div>
  );
}

export function MobilePillButton({
  children,
  onClick,
  palette,
  tone = 'neutral',
  disabled = false,
  style,
}: {
  children: ReactNode;
  onClick?: () => void;
  palette: MobilePalette;
  tone?: 'neutral' | 'accent' | 'success' | 'danger';
  disabled?: boolean;
  style?: CSSProperties;
}) {
  const background = tone === 'accent'
    ? 'rgba(37, 99, 235, 0.18)'
    : tone === 'success'
      ? 'rgba(34, 197, 94, 0.16)'
      : tone === 'danger'
        ? 'rgba(239, 68, 68, 0.16)'
        : palette.panelElevated;
  const border = tone === 'accent'
    ? palette.accentBorder
    : tone === 'success'
      ? palette.successBorder
      : tone === 'danger'
        ? palette.dangerBorder
        : palette.cardBorder;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        minHeight: MOBILE_TOUCH_TARGET,
        borderRadius: MOBILE_CARD_RADIUS,
        border: `1px solid ${border}`,
        background,
        color: palette.rootText,
        padding: '0 14px',
        fontSize: 13,
        fontWeight: 700,
        letterSpacing: MOBILE_BODY_TRACKING,
        fontFamily: mobileFontFamily(),
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        transition: 'opacity 0.18s ease, transform 0.18s ease',
        backdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
        WebkitBackdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export function MobileStatusDot({
  color,
}: {
  color: string;
}) {
  return (
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: 999,
        backgroundColor: color,
        display: 'inline-flex',
        flexShrink: 0,
      }}
    />
  );
}
