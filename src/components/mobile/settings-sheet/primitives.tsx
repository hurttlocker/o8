'use client';

import type { CSSProperties, ReactNode } from 'react';
import {
  MOBILE_BODY_TRACKING,
  MOBILE_CARD_RADIUS,
  MOBILE_HEADING_TRACKING,
  MOBILE_TOUCH_TARGET,
  mobileFontFamily,
  type MobilePalette,
} from '@/app/mobile/mobile-approvals-shared';
import { ICON_BACK, ICON_CARET_RIGHT } from './icons';

export function Icon({
  d,
  fill,
  size = 20,
}: {
  d: string;
  fill: string;
  size?: number;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" aria-hidden="true">
      <path d={d} fill={fill} />
    </svg>
  );
}

export function SectionLabel({
  children,
  palette,
}: {
  children: string;
  palette: MobilePalette;
}) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: palette.subduedText,
        marginBottom: 8,
        marginTop: 18,
        paddingLeft: 16,
        paddingRight: 16,
      }}
    >
      {children}
    </div>
  );
}

export function SectionCard({
  children,
  palette,
}: {
  children: ReactNode;
  palette: MobilePalette;
}) {
  return (
    <div
      style={{
        marginLeft: 12,
        marginRight: 12,
        background: palette.panelElevated,
        border: `1px solid ${palette.cardBorder}`,
        borderRadius: MOBILE_CARD_RADIUS,
        overflow: 'hidden',
      }}
    >
      {children}
    </div>
  );
}

export function Row({
  iconPath,
  label,
  rightValue,
  onClick,
  palette,
  showChevron = true,
  showDivider = true,
}: {
  iconPath: string;
  label: string;
  rightValue?: string;
  onClick: () => void;
  palette: MobilePalette;
  showChevron?: boolean;
  showDivider?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%',
        minHeight: 56,
        paddingLeft: 16,
        paddingRight: 16,
        paddingTop: 0,
        paddingBottom: 0,
        background: 'transparent',
        border: 'none',
        borderBottom: showDivider ? `1px solid ${palette.cardBorder}` : 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        cursor: 'pointer',
        fontFamily: mobileFontFamily(),
        textAlign: 'left',
        color: palette.rootText,
        WebkitTapHighlightColor: 'transparent',
      } as CSSProperties}
    >
      <div
        style={{
          width: 24,
          height: 24,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Icon d={iconPath} fill={palette.iconFill} size={22} />
      </div>
      <span
        style={{
          flex: 1,
          fontSize: 15,
          fontWeight: 500,
          color: palette.rootText,
          letterSpacing: MOBILE_BODY_TRACKING,
        }}
      >
        {label}
      </span>
      {rightValue ? (
        <span
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: palette.subduedText,
            letterSpacing: MOBILE_BODY_TRACKING,
          }}
        >
          {rightValue}
        </span>
      ) : null}
      {showChevron ? (
        <Icon d={ICON_CARET_RIGHT} fill={palette.subduedText} size={16} />
      ) : null}
    </button>
  );
}

export function ToggleRow({
  iconPath,
  label,
  value,
  onChange,
  palette,
  showDivider = true,
}: {
  iconPath: string;
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
  palette: MobilePalette;
  showDivider?: boolean;
}) {
  return (
    <div
      style={{
        width: '100%',
        minHeight: 56,
        paddingLeft: 16,
        paddingRight: 16,
        borderBottom: showDivider ? `1px solid ${palette.cardBorder}` : 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        color: palette.rootText,
      }}
    >
      <div
        style={{
          width: 24,
          height: 24,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Icon d={iconPath} fill={palette.iconFill} size={22} />
      </div>
      <span
        style={{
          flex: 1,
          fontSize: 15,
          fontWeight: 500,
          letterSpacing: MOBILE_BODY_TRACKING,
        }}
      >
        {label}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        style={{
          width: 52,
          height: 32,
          minWidth: 52,
          minHeight: 32,
          borderRadius: 999,
          border: 'none',
          background: value ? palette.success : palette.cardBorder,
          position: 'relative',
          cursor: 'pointer',
          padding: 0,
          flexShrink: 0,
          transition: 'background-color 0.18s ease',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: value ? 22 : 2,
            width: 28,
            height: 28,
            borderRadius: 999,
            background: '#ffffff',
            boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
            transition: 'left 0.18s ease',
          }}
        />
      </button>
    </div>
  );
}

export function SubViewHeader({
  title,
  onBack,
  palette,
}: {
  title: string;
  onBack: () => void;
  palette: MobilePalette;
}) {
  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 2,
        background: palette.sidebarBackground,
        borderBottom: `1px solid ${palette.cardBorder}`,
        paddingTop: 'max(env(safe-area-inset-top, 0px), 8px)',
        paddingLeft: 4,
        paddingRight: 4,
        paddingBottom: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
      }}
    >
      <button
        type="button"
        onClick={onBack}
        aria-label="Back"
        style={{
          width: MOBILE_TOUCH_TARGET,
          height: MOBILE_TOUCH_TARGET,
          minWidth: MOBILE_TOUCH_TARGET,
          minHeight: MOBILE_TOUCH_TARGET,
          borderRadius: 999,
          background: 'transparent',
          border: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          color: palette.rootText,
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <Icon d={ICON_BACK} fill={palette.iconFill} size={22} />
      </button>
      <div
        style={{
          flex: 1,
          fontSize: 17,
          fontWeight: 700,
          textAlign: 'center',
          letterSpacing: MOBILE_HEADING_TRACKING,
          color: palette.rootText,
          paddingRight: MOBILE_TOUCH_TARGET,
        }}
      >
        {title}
      </div>
    </div>
  );
}
