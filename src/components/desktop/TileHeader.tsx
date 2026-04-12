'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type React from 'react';

/* ── Inline SVG icons ───────────────────────────────────────── */

function CloseIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function DotsThreeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <circle cx="6" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="18" cy="12" r="2" />
    </svg>
  );
}

function SplitVerticalIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d="M12 4v16" />
      <path d="M6 7v10" />
      <path d="M18 7v10" />
    </svg>
  );
}

function SplitHorizontalIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d="M4 12h16" />
      <path d="M7 6h10" />
      <path d="M7 18h10" />
    </svg>
  );
}

function MenuCloseIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

/* ── Component ──────────────────────────────────────────────── */

interface TileHeaderProps {
  label: string;
  active: boolean;
  canClose: boolean;
  onOpenPicker?: () => void;
  onSplitVertical: () => void;
  onSplitHorizontal: () => void;
  onClose: () => void;
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
  const [pillHovered, setPillHovered] = useState(false);
  const [closeHovered, setCloseHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuBtnHovered, setMenuBtnHovered] = useState(false);
  const [hoveredItem, setHoveredItem] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  /* Close popover on outside click / Escape */
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        menuBtnRef.current && !menuBtnRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const handlePillClick = useCallback(() => {
    onOpenPicker?.();
  }, [onOpenPicker]);

  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
  }, [onClose]);

  const menuItems: Array<{
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
    disabled?: boolean;
  }> = [
    {
      icon: <SplitVerticalIcon />,
      label: 'Split Vertical',
      onClick: () => { onSplitVertical(); setMenuOpen(false); },
    },
    {
      icon: <SplitHorizontalIcon />,
      label: 'Split Horizontal',
      onClick: () => { onSplitHorizontal(); setMenuOpen(false); },
    },
    {
      icon: <MenuCloseIcon />,
      label: 'Close Tile',
      onClick: () => { onClose(); setMenuOpen(false); },
      disabled: !canClose,
    },
  ];

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        minHeight: 36,
        maxHeight: 36,
        paddingLeft: 12,
        paddingRight: 8,
        gap: 2,
        backgroundColor: 'rgba(0, 0, 0, 0.015)',
        borderBottomWidth: '0.5px',
        borderBottomStyle: 'solid',
        borderBottomColor: 'rgba(0, 0, 0, 0.04)',
      }}
    >
      {/* Tab scroll container */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          flex: 1,
          minWidth: 0,
          overflowX: 'auto',
          overflowY: 'hidden',
          scrollbarWidth: 'none',
        } as React.CSSProperties}
      >
        {/* Tab pill */}
        <div
          role="tab"
          tabIndex={0}
          onClick={handlePillClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handlePillClick();
            }
          }}
          onMouseEnter={() => setPillHovered(true)}
          onMouseLeave={() => { setPillHovered(false); setCloseHovered(false); }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            paddingTop: 5,
            paddingBottom: 5,
            paddingLeft: 10,
            paddingRight: 10,
            borderRadius: 8,
            borderWidth: '0.5px',
            borderStyle: 'solid',
            borderColor: active ? 'rgba(0, 0, 0, 0.06)' : 'transparent',
            backgroundColor: active
              ? '#ffffff'
              : pillHovered
                ? 'rgba(0, 0, 0, 0.03)'
                : 'transparent',
            fontSize: 12,
            fontWeight: active ? 600 : 500,
            letterSpacing: '-0.006em',
            color: active ? '#111827' : '#5b6475',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: 180,
            cursor: onOpenPicker ? 'pointer' : 'default',
            transition: 'background-color 150ms ease, color 150ms ease',
            flexShrink: 0,
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            boxShadow: active
              ? '0 1px 3px rgba(0, 0, 0, 0.06), 0 0.5px 1px rgba(0, 0, 0, 0.04)'
              : 'none',
          }}
        >
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {label}
          </span>

          {canClose && (
            <button
              type="button"
              onClick={handleClose}
              onMouseEnter={() => setCloseHovered(true)}
              onMouseLeave={() => setCloseHovered(false)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                paddingTop: 0,
                paddingRight: 0,
                paddingBottom: 0,
                paddingLeft: 0,
                borderWidth: 0,
                backgroundColor: 'transparent',
                cursor: 'pointer',
                opacity: pillHovered ? (closeHovered ? 1 : 0.5) : 0,
                width: pillHovered ? 14 : 0,
                overflow: 'hidden',
                transition: 'opacity 120ms ease, width 120ms ease',
                color: 'inherit',
                flexShrink: 0,
              }}
            >
              <CloseIcon size={10} />
            </button>
          )}
        </div>
      </div>

      {/* Overflow menu */}
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <button
          ref={menuBtnRef}
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          onMouseEnter={() => setMenuBtnHovered(true)}
          onMouseLeave={() => setMenuBtnHovered(false)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: 8,
            borderWidth: 0,
            backgroundColor: menuBtnHovered ? 'rgba(0, 0, 0, 0.04)' : 'transparent',
            color: menuBtnHovered ? '#5b6475' : '#9ca3af',
            cursor: 'pointer',
            flexShrink: 0,
            transition: 'background-color 120ms ease, color 120ms ease',
          }}
        >
          <DotsThreeIcon size={16} />
        </button>

        {menuOpen && (
          <div
            ref={menuRef}
            style={{
              position: 'absolute',
              top: '100%',
              right: 0,
              marginTop: 4,
              minWidth: 180,
              paddingTop: 4,
              paddingRight: 4,
              paddingBottom: 4,
              paddingLeft: 4,
              borderRadius: 10,
              backgroundColor: 'rgba(255, 255, 255, 0.96)',
              backdropFilter: 'blur(20px) saturate(1.8)',
              WebkitBackdropFilter: 'blur(20px) saturate(1.8)',
              boxShadow:
                '0 8px 32px rgba(0, 0, 0, 0.12), 0 0 0 0.5px rgba(0, 0, 0, 0.06)',
              zIndex: 100,
            } as React.CSSProperties}
          >
            {menuItems.map((item, i) => (
              <button
                key={item.label}
                type="button"
                disabled={item.disabled}
                onClick={item.onClick}
                onMouseEnter={() => setHoveredItem(i)}
                onMouseLeave={() => setHoveredItem(null)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  paddingTop: 7,
                  paddingRight: 10,
                  paddingBottom: 7,
                  paddingLeft: 10,
                  borderRadius: 6,
                  borderWidth: 0,
                  backgroundColor:
                    hoveredItem === i && !item.disabled
                      ? 'rgba(0, 0, 0, 0.04)'
                      : 'transparent',
                  fontSize: 12,
                  fontWeight: 500,
                  color: item.disabled ? '#9ca3af' : '#111827',
                  cursor: item.disabled ? 'default' : 'pointer',
                  opacity: item.disabled ? 0.5 : 1,
                  fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                }}
              >
                <span style={{ color: item.disabled ? '#9ca3af' : '#5b6475', display: 'flex' }}>
                  {item.icon}
                </span>
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
