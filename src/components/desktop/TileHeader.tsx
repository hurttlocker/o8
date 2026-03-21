'use client';

import type React from 'react';

function SplitVerticalIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 4v16" />
      <path d="M6 7v10" />
      <path d="M18 7v10" />
    </svg>
  );
}

function SplitHorizontalIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M4 12h16" />
      <path d="M7 6h10" />
      <path d="M7 18h10" />
    </svg>
  );
}

function XIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

interface TileHeaderProps {
  label: string;
  active: boolean;
  canClose: boolean;
  onOpenPicker?: () => void;
  onSplitVertical: () => void;
  onSplitHorizontal: () => void;
  onClose: () => void;
}

function TileHeaderButton({
  title,
  disabled,
  children,
  onClick,
}: {
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: 8,
        borderWidth: 0,
        backgroundColor: 'transparent',
        color: disabled ? 'var(--t-text-faint)' : 'var(--t-text-secondary)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

export function TileHeader({
  label,
  active,
  canClose,
  onOpenPicker,
  onSplitVertical,
  onSplitHorizontal,
  onClose,
}: TileHeaderProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        minHeight: 36,
        maxHeight: 36,
        paddingRight: 6,
        paddingLeft: 8,
        background: 'var(--t-panel-translucent)',
        backdropFilter: 'blur(20px) saturate(1.6)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: active ? 'rgba(37,99,235,0.18)' : 'var(--t-divider)',
      } as React.CSSProperties}
    >
      {onOpenPicker ? (
        <button
          type="button"
          onClick={onOpenPicker}
          title="Change tile content"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            minWidth: 0,
            borderWidth: 0,
            backgroundColor: 'transparent',
            color: active ? 'var(--t-text)' : 'var(--t-text-secondary)',
            cursor: 'pointer',
            paddingTop: 0,
            paddingRight: 8,
            paddingBottom: 0,
            paddingLeft: 0,
            fontSize: 12,
            fontWeight: active ? 700 : 600,
            letterSpacing: '-0.01em',
            flexGrow: 1,
            flexShrink: 1,
            flexBasis: '0%',
            textAlign: 'left',
          }}
        >
          <span style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {label}
          </span>
        </button>
      ) : (
        <div style={{
          minWidth: 0,
          color: active ? 'var(--t-text)' : 'var(--t-text-secondary)',
          paddingRight: 8,
          fontSize: 12,
          fontWeight: active ? 700 : 600,
          letterSpacing: '-0.01em',
          flexGrow: 1,
          flexShrink: 1,
          flexBasis: '0%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {label}
        </div>
      )}

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        flexShrink: 0,
      }}>
        <TileHeaderButton title="Split vertically" onClick={onSplitVertical}>
          <SplitVerticalIcon />
        </TileHeaderButton>
        <TileHeaderButton title="Split horizontally" onClick={onSplitHorizontal}>
          <SplitHorizontalIcon />
        </TileHeaderButton>
        <TileHeaderButton title="Close tile" disabled={!canClose} onClick={onClose}>
          <XIcon />
        </TileHeaderButton>
      </div>
    </div>
  );
}
