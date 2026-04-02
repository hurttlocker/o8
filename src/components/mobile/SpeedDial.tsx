'use client';

import { useState, useRef, memo, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from './ThemeContext';

export type MobileScreen = 'chat' | 'fleet' | 'memory' | 'approvals' | 'costs' | 'settings' | 'issues';

interface SpeedDialProps {
  activeScreen: MobileScreen;
  onNavigate: (screen: MobileScreen) => void;
  onNewChat?: () => void;
  approvalCount?: number;
}

const MENU_ITEMS: { screen: MobileScreen; label: string; iconPath: string }[] = [
  {
    screen: 'chat',
    label: 'Code',
    iconPath: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  },
  {
    screen: 'fleet',
    label: 'Agents',
    iconPath: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  },
  {
    screen: 'memory',
    label: 'Memory',
    iconPath: 'M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z M9 21h6',
  },
  {
    screen: 'issues',
    label: 'Issues & PRs',
    iconPath: 'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z M12 8v4 M12 16h.01',
  },
  {
    screen: 'approvals',
    label: 'Activity',
    iconPath: 'M22 12h-4l-3 9L9 3l-3 9H2',
  },
  {
    screen: 'costs',
    label: 'Costs',
    iconPath: 'M12 2v20 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  },
  {
    screen: 'settings',
    label: 'Settings',
    iconPath: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  },
];

export const SpeedDialButton = memo(function SpeedDialButton({
  activeScreen,
  onNavigate,
  onNewChat,
  approvalCount = 0,
}: SpeedDialProps) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const primaryText = colors.text;
  const activeText = colors.blueAccent;
  const surfaceBorder = colors.cardBorder;
  const approvalBadgeBackground = colors.red;
  const closedBackground = 'rgba(0, 0, 0, 0.8)';
  const openBackground = 'rgba(0, 0, 0, 0.88)';
  const pillBackground = 'rgba(44, 44, 46, 0.9)';
  const pillActiveBackground = 'rgba(10, 132, 255, 0.2)';
  const menuButtonStyle: CSSProperties = {
    width: 44,
    height: 44,
    minWidth: 44,
    minHeight: 44,
    borderRadius: 999,
    background: open ? openBackground : closedBackground,
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    border: `1px solid ${surfaceBorder}`,
    color: primaryText,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    boxShadow: open
      ? '0 14px 30px rgba(0, 0, 0, 0.34)'
      : '0 10px 24px rgba(0, 0, 0, 0.24)',
    transition: 'background 220ms ease, box-shadow 220ms ease, transform 180ms ease',
    WebkitTapHighlightColor: 'transparent',
    position: 'relative',
    padding: 0,
  };
  const backdropStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.85)',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    zIndex: 9997,
  };

  // Close-on-outside-tap handled by frost backdrop onClick.
  // No document-level touchstart listener — it was killing pill taps
  // because the portaled pills are outside menuRef.

  return (
    <div ref={menuRef} style={{ position: 'relative', flexShrink: 0, display: 'flex', alignItems: 'center' }}>
      {/* Soft floating menu button */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-label={approvalCount > 0 ? `Navigation menu, ${approvalCount} pending approvals` : 'Navigation menu'}
        style={menuButtonStyle}
      >
        <div style={{
          width: 18, height: 12,
          display: 'flex', flexDirection: 'column',
          justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span style={{
            display: 'block', width: 18, height: 1.5, borderRadius: 1,
            background: 'currentColor',
            transition: 'all 250ms cubic-bezier(0.32, 0.72, 0, 1)',
            transform: open ? 'translateY(5.25px) rotate(45deg)' : 'none',
          }} />
          <span style={{
            display: 'block', width: 12, height: 1.5, borderRadius: 1,
            background: 'currentColor',
            transition: 'all 200ms ease',
            opacity: open ? 0 : 1,
          }} />
          <span style={{
            display: 'block', width: 16, height: 1.5, borderRadius: 1,
            background: 'currentColor',
            transition: 'all 250ms cubic-bezier(0.32, 0.72, 0, 1)',
            transform: open ? 'translateY(-5.25px) rotate(-45deg)' : 'none',
          }} />
        </div>

        {!open && approvalCount > 0 && (
          <span style={{
            position: 'absolute', top: -4, right: -4,
            width: 18, height: 18, borderRadius: 9,
            background: approvalBadgeBackground, color: '#FFFFFF',
            fontSize: 11, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            lineHeight: 1,
            pointerEvents: 'none',
          }}>
            {approvalCount > 1 ? approvalCount : null}
          </span>
        )}
      </button>

      {/* Portal: frosted overlay + floating pills at document.body level */}
      {open && typeof document !== 'undefined' && createPortal(
        <>
          {/* Frost backdrop — separate layer, closes menu on tap */}
          <div
            onClick={() => setOpen(false)}
            style={backdropStyle}
          />

          {/* Floating pills — separate layer above frost */}
          <div style={{
            position: 'fixed',
            top: 'calc(env(safe-area-inset-top, 0px) + 52px)',
            left: 16,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 10,
            zIndex: 9999,
          }}>
          {onNewChat ? (
            <button
              type="button"
              onTouchEnd={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onNewChat();
                setOpen(false);
              }}
              onClick={() => {
                onNewChat();
                setOpen(false);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
                pointerEvents: 'auto',
                touchAction: 'manipulation',
                position: 'relative',
                minHeight: 44,
              }}
            >
              <span style={{
                padding: '12px 20px',
                borderRadius: 22,
                background: '#0A84FF',
                border: '1px solid rgba(10,132,255,0.36)',
                color: '#FFFFFF',
                fontSize: 13,
                fontWeight: 700,
                fontFamily: '-apple-system, system-ui, sans-serif',
                letterSpacing: '-0.01em',
                boxShadow: '0 14px 30px rgba(10,132,255,0.24)',
                position: 'relative',
                pointerEvents: 'none',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
              }}>
                New Chat
              </span>
              <span style={{
                width: 44,
                height: 44,
                borderRadius: 999,
                background: '#0A84FF',
                border: '1px solid rgba(10,132,255,0.36)',
                color: '#FFFFFF',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 14px 30px rgba(10,132,255,0.24)',
                pointerEvents: 'none',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
              }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14" />
                  <path d="M5 12h14" />
                </svg>
              </span>
            </button>
          ) : null}
          {MENU_ITEMS.map((item) => {
            const isActive = item.screen === activeScreen;
            return (
              <button
                key={item.screen}
                type="button"
                onTouchEnd={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onNavigate(item.screen);
                  setOpen(false);
                }}
                onClick={() => {
                  onNavigate(item.screen);
                  setOpen(false);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px',
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                  pointerEvents: 'auto',
                  touchAction: 'manipulation',
                  position: 'relative',
                  minHeight: 44,
                }}
              >
                {/* Label pill */}
                <span style={{
                  padding: '12px 20px',
                  borderRadius: 22,
                  background: isActive ? pillActiveBackground : pillBackground,
                  border: `1px solid ${surfaceBorder}`,
                  color: isActive ? activeText : primaryText,
                  fontSize: 13,
                  fontWeight: isActive ? 700 : 600,
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  letterSpacing: '-0.01em',
                  boxShadow: isActive
                    ? '0 14px 30px rgba(0, 0, 0, 0.28)'
                    : '0 10px 24px rgba(0, 0, 0, 0.18)',
                  position: 'relative',
                  pointerEvents: 'none',
                  backdropFilter: 'blur(20px)',
                  WebkitBackdropFilter: 'blur(20px)',
                }}>
                  {item.label}
                </span>

                {/* Icon circle */}
                <span style={{
                  width: 44, height: 44,
                  borderRadius: 999,
                  background: isActive ? pillActiveBackground : pillBackground,
                  border: `1px solid ${surfaceBorder}`,
                  color: isActive ? activeText : primaryText,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: isActive
                    ? '0 14px 30px rgba(0, 0, 0, 0.28)'
                    : '0 10px 24px rgba(0, 0, 0, 0.18)',
                  pointerEvents: 'none',
                  backdropFilter: 'blur(20px)',
                  WebkitBackdropFilter: 'blur(20px)',
                }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d={item.iconPath} />
                  </svg>
                </span>
              </button>
            );
          })}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
});
