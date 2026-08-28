'use client';

/**
 * ContextMenu — iOS-style long-press context menu.
 * Appears as a frosted glass card near the touch point.
 * Used on agent cards, notifications, PR cards.
 */

import { useEffect, useRef, memo, useCallback } from 'react';
import { triggerHaptic } from '@/lib/mobile/haptic';

export interface ContextMenuItem {
  id: string;
  label: string;
  iconPath: string;
  color?: string;
  destructive?: boolean;
}

interface ContextMenuProps {
  visible: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
}

export const ContextMenu = memo(function ContextMenu({
  visible, x, y, items, onSelect, onClose,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) return;
    const handler = (e: TouchEvent | MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Small delay so the opening touch doesn't immediately close
    const timer = setTimeout(() => {
      document.addEventListener('touchstart', handler, { passive: true });
      document.addEventListener('mousedown', handler);
    }, 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('touchstart', handler);
      document.removeEventListener('mousedown', handler);
    };
  }, [visible, onClose]);

  if (!visible) return null;

  // Position: ensure menu stays on screen
  const menuWidth = 180;
  const menuHeight = items.length * 44 + 12;
  const safeX = Math.min(Math.max(x - menuWidth / 2, 12), window.innerWidth - menuWidth - 12);
  const safeY = y + menuHeight > window.innerHeight - 40
    ? y - menuHeight - 8
    : y + 8;

  return (
    <>
      {/* Backdrop blur */}
      <div
        onClick={onClose}
        onTouchEnd={(e) => { e.preventDefault(); onClose(); }}
        style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.15)',
          backdropFilter: 'blur(2px)',
          WebkitBackdropFilter: 'blur(2px)',
          animation: 'ctxFadeIn 150ms ease',
        }}
      />

      {/* Menu card */}
      <div
        ref={menuRef}
        style={{
          position: 'fixed',
          left: safeX, top: safeY,
          width: menuWidth,
          zIndex: 10000,
          borderRadius: 14,
          background: 'rgba(255,255,255,0.92)',
          backdropFilter: 'blur(40px) saturate(1.8)',
          WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.14), 0 1px 4px rgba(0,0,0,0.06)',
          overflow: 'hidden',
          animation: 'ctxScaleIn 200ms cubic-bezier(0.34, 1.36, 0.64, 1)',
          transformOrigin: `${x - safeX}px ${y < safeY ? 'bottom' : 'top'}`,
          padding: '6px 0',
        }}
      >
        {items.map((item, i) => (
          <button
            key={item.id}
            type="button"
            onClick={() => { triggerHaptic(item.destructive ? 'warn' : 'tap'); onSelect(item.id); onClose(); }}
            onTouchEnd={(e) => { e.preventDefault(); triggerHaptic(item.destructive ? 'warn' : 'tap'); onSelect(item.id); onClose(); }}
            style={{
              width: '100%',
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 14px',
              border: 'none',
              borderBottom: i < items.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none',
              background: 'transparent',
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
              touchAction: 'manipulation',
              textAlign: 'left',
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
              stroke={item.destructive ? '#ff3b30' : item.color || '#0a0a0a'}
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d={item.iconPath} />
            </svg>
            <span style={{
              fontSize: 14, fontWeight: 500,
              color: item.destructive ? '#ff3b30' : '#0a0a0a',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}>
              {item.label}
            </span>
          </button>
        ))}
      </div>

      <style>{`
        @keyframes ctxFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes ctxScaleIn {
          from { opacity: 0; transform: scale(0.85); }
          to { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </>
  );
});

/**
 * useLongPress — Hook for iOS-style long-press detection.
 * Returns handlers to spread on the target element.
 */
export function useLongPress(onLongPress: (x: number, y: number) => void, delay = 500) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const posRef = useRef({ x: 0, y: 0 });
  const movedRef = useRef(false);
  const callbackRef = useRef(onLongPress);
  callbackRef.current = onLongPress;

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    movedRef.current = false;
    posRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    timerRef.current = setTimeout(() => {
      if (!movedRef.current) {
        triggerHaptic('tap');
        callbackRef.current(posRef.current.x, posRef.current.y);
      }
    }, delay);
  }, [delay]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    const dx = Math.abs(e.touches[0].clientX - posRef.current.x);
    const dy = Math.abs(e.touches[0].clientY - posRef.current.y);
    if (dx > 10 || dy > 10) {
      movedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    }
  }, []);

  const onTouchEnd = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { onTouchStart, onTouchMove, onTouchEnd };
}
