'use client';

import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFloatingSurfaceMaterial } from '../FloatingSurface';

export function GlassModal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 560,
  popoverSurface = false,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  popoverSurface?: boolean;
}) {
  const material = useFloatingSurfaceMaterial();
  useEffect(() => {
    if (!open) return undefined;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9998,
          background: 'rgba(0, 0, 0, 0.05)',
          ...(material.isAllGlass ? {} : { backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }),
        } as CSSProperties}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        style={{
          position: 'fixed',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          width: `min(${width}px, calc(100vw - 28px))`,
          maxHeight: 'calc(100vh - 28px)',
          zIndex: 9999,
          ...(popoverSurface ? material.overlayStyle : {
            background: 'var(--t-panel-solid)',
            backdropFilter: 'blur(80px) saturate(2.2)',
            WebkitBackdropFilter: 'blur(80px) saturate(2.2)',
          }),
          ...material.textStyle,
          border: '1px solid var(--t-panel-border)',
          borderRadius: 16,
          boxShadow: '0 24px 80px rgba(0, 0, 0, 0.08), 0 8px 32px rgba(0, 0, 0, 0.04), inset 0 0.5px 0 var(--t-panel-border)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
            padding: 'var(--cortex-dialog-header-padding)',
            borderBottom: '1px solid var(--t-divider-subtle)',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 16,
                fontWeight: 300,
                color: 'var(--t-text)',
                letterSpacing: '-0.2px',
                lineHeight: 1.25,
              }}
            >
              {title}
            </div>
            {subtitle ? (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 13,
                  fontWeight: 300,
                  letterSpacing: '-0.1px',
                  lineHeight: 1.45,
                  color: 'var(--t-text-muted)',
                }}
              >
                {subtitle}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 28,
              height: 28,
              padding: 0,
              borderRadius: 14,
              border: 'none',
              background: 'var(--t-btn-secondary-bg)',
              color: 'var(--t-text-muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}><path d="m6 6 12 12M6 18 18 6" /></svg>
          </button>
        </div>

        <div
          style={{
            padding: 'var(--cortex-dialog-body-padding)',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {children}
        </div>

        {footer ? (
          <div
            style={{
              padding: 'var(--cortex-dialog-footer-padding)',
              borderTop: '1px solid var(--t-divider-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 10,
            }}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </>,
    document.body,
  );
}

export function RepoActionButton({
  label,
  icon,
  onClick,
  disabled = false,
  active = false,
  danger = false,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  danger?: boolean;
}) {
  const color = danger ? '#ef4444' : active ? 'var(--t-text)' : 'var(--t-text-secondary)';
  const border = danger ? 'rgba(239, 68, 68, 0.18)' : active ? 'rgba(37, 99, 235, 0.16)' : 'var(--t-btn-secondary-border)';
  const background = danger ? 'rgba(239, 68, 68, 0.08)' : active ? 'rgba(37, 99, 235, 0.08)' : 'var(--t-panel-hover)';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        minHeight: 32,
        paddingTop: 8,
        paddingRight: 10,
        paddingBottom: 8,
        paddingLeft: 10,
        borderRadius: 10,
        border: `1px solid ${border}`,
        background,
        color,
        fontSize: 11,
        fontWeight: 300,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        fontFamily: 'var(--font-sans-system)',
        transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1), opacity 150ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      {icon}
      {label}
    </button>
  );
}

export function SetupModeButton({
  label,
  selected,
  onClick,
  disabled = false,
  title,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        flex: 1,
        minHeight: 34,
        paddingTop: 8,
        paddingRight: 10,
        paddingBottom: 8,
        paddingLeft: 10,
        borderRadius: 10,
        border: selected ? '1px solid rgba(37, 99, 235, 0.2)' : '1px solid var(--t-btn-secondary-border)',
        background: selected ? 'var(--t-accent-soft)' : 'var(--t-bg-card)',
        color: selected ? 'var(--t-text)' : 'var(--t-text-muted)',
        fontSize: 11,
        fontWeight: 300,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.48 : 1,
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      {label}
    </button>
  );
}
