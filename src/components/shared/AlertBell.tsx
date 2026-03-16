'use client';

/**
 * AlertBell — bell icon with unread badge.
 *
 * On mobile: replaces the hamburger button when alerts exist.
 * On desktop: sits in the top bar.
 */

import { memo, useEffect, useState } from 'react';
import { Bell } from 'lucide-react';

interface AlertBellProps {
  unreadCount: number;
  urgentCount: number;
  onClick: () => void;
  /** Size variant */
  size?: 'mobile' | 'desktop';
}

export const AlertBell = memo(function AlertBell({
  unreadCount,
  urgentCount,
  onClick,
  size = 'desktop',
}: AlertBellProps) {
  // Prevent hydration mismatch — alert state is client-only
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;

  const isMobile = size === 'mobile';
  const buttonSize = isMobile ? 36 : 32;
  const iconSize = isMobile ? 18 : 16;
  const hasUrgent = urgentCount > 0;
  const bgColor = hasUrgent ? '#ff3b30' : '#ff9f0a';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${unreadCount} alert${unreadCount !== 1 ? 's' : ''}`}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: buttonSize,
        height: buttonSize,
        borderRadius: buttonSize / 2,
        border: 'none',
        background: isMobile ? bgColor : 'transparent',
        color: isMobile ? '#fff' : '#6b7280',
        cursor: 'pointer',
        padding: 0,
        WebkitTapHighlightColor: 'transparent',
        transition: 'transform 220ms cubic-bezier(0.32, 0.72, 0, 1)',
        boxShadow: isMobile
          ? `0 4px 12px ${hasUrgent ? 'rgba(255,59,48,0.3)' : 'rgba(255,159,10,0.3)'}`
          : 'none',
      }}
    >
      <Bell
        size={iconSize}
        strokeWidth={2.1}
        style={{
          // Subtle shake animation when urgent
          animation: hasUrgent ? 'alert-bell-shake 1.5s ease-in-out infinite' : 'none',
        }}
      />
      {/* Badge */}
      {unreadCount > 0 && !isMobile ? (
        <span
          style={{
            position: 'absolute',
            top: -2,
            right: -2,
            minWidth: 16,
            height: 16,
            borderRadius: 8,
            background: bgColor,
            color: '#fff',
            fontSize: '10px',
            fontWeight: 700,
            lineHeight: '16px',
            textAlign: 'center',
            padding: '0 4px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          }}
        >
          {unreadCount > 9 ? '9+' : unreadCount}
        </span>
      ) : null}
    </button>
  );
});
