'use client';

/**
 * SessionPillContextMenu — right-click menu for session pills (issue #663).
 *
 * Floating menu portal-rendered at the cursor coordinate. Backdrop click,
 * escape, and any selection close it. Apple HIG: 44px touch targets,
 * spring-curve open animation, palette tokens only.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

export type SessionPillSplitDirection = 'horizontal' | 'vertical';

export interface SessionPillContextMenuItem {
  id: string;
  label: string;
  description?: string;
  iconDirection: SessionPillSplitDirection;
  disabled?: boolean;
  onSelect: () => void;
}

interface SessionPillContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  items: SessionPillContextMenuItem[];
  onClose: () => void;
}

const MENU_WIDTH = 248;
const ESTIMATED_ROW_HEIGHT = 56;

export function SessionPillContextMenu({
  open,
  x,
  y,
  items,
  onClose,
}: SessionPillContextMenuProps) {
  const [mounted, setMounted] = useState(false);
  const [entered, setEntered] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      // Schedule the reset on the next frame so we don't synchronously call
      // setState during render in the parent's reconciliation pass.
      const raf = requestAnimationFrame(() => setEntered(false));
      return () => cancelAnimationFrame(raf);
    }
    const mountRaf = requestAnimationFrame(() => {
      setMounted(true);
      // Two RAFs so the spring kick-in doesn't get squashed by the same paint.
      const enterRaf = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(enterRaf);
    });
    return () => cancelAnimationFrame(mountRaf);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, open]);

  if (!open || !mounted) return null;
  if (typeof document === 'undefined') return null;

  // Keep the menu inside the viewport.
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
  const menuHeight = items.length * ESTIMATED_ROW_HEIGHT + 12;
  const left = Math.max(8, Math.min(x, viewportWidth - MENU_WIDTH - 8));
  const top = Math.max(8, Math.min(y, viewportHeight - menuHeight - 8));

  const containerStyle: CSSProperties = {
    position: 'fixed',
    left,
    top,
    width: MENU_WIDTH,
    background: 'var(--t-bg-card)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--t-border)',
    borderRadius: 14,
    boxShadow: 'var(--t-glass-shadow, 0 18px 38px rgba(15, 23, 42, 0.18))',
    paddingTop: 6,
    paddingRight: 6,
    paddingBottom: 6,
    paddingLeft: 6,
    zIndex: 240,
    transformOrigin: 'top left',
    transform: entered ? 'scale(1) translateY(0)' : 'scale(0.96) translateY(-4px)',
    opacity: entered ? 1 : 0,
    // Apple HIG-ish spring curve for the pop-in.
    transition: 'transform 220ms cubic-bezier(0.34, 1.36, 0.64, 1), opacity 160ms cubic-bezier(0.22, 1, 0.36, 1)',
    fontFamily: 'var(--font-sans-system)',
  };

  const backdrop = (
    <div
      onClick={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'transparent',
        zIndex: 239,
      }}
    />
  );

  return createPortal(
    <>
      {backdrop}
      <div
        ref={menuRef}
        role="menu"
        aria-orientation="vertical"
        style={containerStyle}
      >
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect();
              onClose();
            }}
            style={{
              width: '100%',
              minHeight: 44,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              paddingTop: 8,
              paddingRight: 12,
              paddingBottom: 8,
              paddingLeft: 12,
              borderRadius: 10,
              borderWidth: 0,
              background: 'transparent',
              color: item.disabled ? 'var(--t-text-faint)' : 'var(--t-text)',
              cursor: item.disabled ? 'not-allowed' : 'pointer',
              textAlign: 'left',
              fontFamily: 'inherit',
            }}
            onMouseEnter={(event) => {
              if (item.disabled) return;
              event.currentTarget.style.background = 'var(--t-panel)';
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = 'transparent';
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-border)',
                background: 'var(--t-panel)',
                color: 'var(--t-text-secondary)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <SplitDirectionIcon direction={item.iconDirection} />
            </span>
            <span
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                minWidth: 0,
                flex: 1,
              }}
            >
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: 'inherit',
                  letterSpacing: '-0.01em',
                }}
              >
                {item.label}
              </span>
              {item.description ? (
                <span
                  style={{
                    fontSize: 11,
                    color: 'var(--t-text-secondary)',
                    fontWeight: 500,
                  }}
                >
                  {item.description}
                </span>
              ) : null}
            </span>
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
}

function SplitDirectionIcon({ direction }: { direction: SessionPillSplitDirection }) {
  if (direction === 'vertical') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3.5" y="5" width="7.5" height="14" rx="2" />
        <rect x="13" y="5" width="7.5" height="14" rx="2" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="7.5" rx="2" />
      <rect x="3.5" y="13" width="17" height="7.5" rx="2" />
    </svg>
  );
}
