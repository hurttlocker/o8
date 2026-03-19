'use client';

import { useState, useEffect, useRef, memo } from 'react';

export type MobileScreen = 'chat' | 'fleet' | 'memory' | 'approvals' | 'costs' | 'settings';

interface SpeedDialProps {
  activeScreen: MobileScreen;
  onNavigate: (screen: MobileScreen) => void;
  approvalCount?: number;
}

const MENU_ITEMS: { screen: MobileScreen; label: string; iconPath: string }[] = [
  {
    screen: 'chat',
    label: 'Chat',
    iconPath: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  },
  {
    screen: 'fleet',
    label: 'Fleet',
    iconPath: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  },
  {
    screen: 'memory',
    label: 'Memory',
    iconPath: 'M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z M9 21h6',
  },
  {
    screen: 'approvals',
    label: 'Approvals',
    iconPath: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
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

/**
 * SpeedDialButton — the hamburger trigger that lives in the TopBar.
 * Renders a menu button + dropdown when open.
 */
export const SpeedDialButton = memo(function SpeedDialButton({
  activeScreen,
  onNavigate,
  approvalCount = 0,
}: SpeedDialProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside tap
  useEffect(() => {
    if (!open) return;
    const handler = (e: TouchEvent | MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('touchstart', handler, { passive: true });
    document.addEventListener('mousedown', handler);
    return () => {
      document.removeEventListener('touchstart', handler);
      document.removeEventListener('mousedown', handler);
    };
  }, [open]);

  return (
    <div ref={menuRef} style={{ position: 'relative', flexShrink: 0 }}>
      {/* Hamburger button — matches existing TopBar circle button */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-label="Navigation menu"
        style={{
          width: 36, height: 36,
          borderRadius: 12,
          background: open ? '#1a1a1a' : '#ef4444',
          border: 'none',
          color: '#ffffff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          boxShadow: open
            ? '0 2px 8px rgba(0,0,0,0.2)'
            : '0 4px 12px rgba(239,68,68,0.25)',
          transition: 'all 250ms cubic-bezier(0.32, 0.72, 0, 1)',
          WebkitTapHighlightColor: 'transparent',
          position: 'relative',
        }}
      >
        {/* Animated hamburger → × */}
        <div style={{
          width: 16, height: 12,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <span style={{
            display: 'block',
            width: open ? 16 : 16,
            height: 2,
            borderRadius: 1,
            background: '#fff',
            transition: 'all 250ms cubic-bezier(0.32, 0.72, 0, 1)',
            transform: open ? 'translateY(5px) rotate(45deg)' : 'none',
          }} />
          <span style={{
            display: 'block',
            width: 12,
            height: 2,
            borderRadius: 1,
            background: '#fff',
            transition: 'all 200ms ease',
            opacity: open ? 0 : 1,
            transform: open ? 'scale(0)' : 'scale(1)',
          }} />
          <span style={{
            display: 'block',
            width: open ? 16 : 16,
            height: 2,
            borderRadius: 1,
            background: '#fff',
            transition: 'all 250ms cubic-bezier(0.32, 0.72, 0, 1)',
            transform: open ? 'translateY(-5px) rotate(-45deg)' : 'none',
          }} />
        </div>

        {/* Approval badge on button */}
        {!open && approvalCount > 0 && (
          <span style={{
            position: 'absolute',
            top: -4, right: -4,
            width: 16, height: 16,
            borderRadius: '50%',
            background: '#ff3b30',
            color: '#fff',
            fontSize: 9,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '2px solid #fff',
          }}>
            {approvalCount}
          </span>
        )}
      </button>

      {/* Dropdown menu */}
      {open && (
        <>
          {/* Backdrop */}
          <div style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.3)',
            zIndex: 9998,
            animation: 'speedDialFade 200ms ease',
          }} />

          {/* Menu panel */}
          <div style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 8,
            width: 200,
            borderRadius: 16,
            background: 'rgba(28, 28, 30, 0.95)',
            backdropFilter: 'blur(40px) saturate(1.8)',
            WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
            border: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
            padding: '6px 0',
            zIndex: 9999,
            animation: 'speedDialSlide 250ms cubic-bezier(0.32, 0.72, 0, 1)',
          }}>
            {MENU_ITEMS.map((item) => {
              const isActive = item.screen === activeScreen;
              return (
                <button
                  key={item.screen}
                  type="button"
                  onClick={() => {
                    onNavigate(item.screen);
                    setOpen(false);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    width: '100%',
                    padding: '12px 16px',
                    border: 'none',
                    background: isActive ? 'rgba(239, 68, 68, 0.12)' : 'transparent',
                    cursor: 'pointer',
                    WebkitTapHighlightColor: 'transparent',
                    transition: 'background 150ms ease',
                  }}
                >
                  {/* Icon */}
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                    stroke={isActive ? '#ef4444' : 'rgba(255,255,255,0.7)'}
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d={item.iconPath} />
                  </svg>

                  {/* Label */}
                  <span style={{
                    fontSize: 15,
                    fontWeight: isActive ? 700 : 500,
                    fontFamily: '-apple-system, system-ui, sans-serif',
                    color: isActive ? '#ef4444' : '#ffffff',
                    letterSpacing: '-0.01em',
                    flex: 1,
                    textAlign: 'left',
                  }}>
                    {item.label}
                  </span>

                  {/* Approval badge */}
                  {item.screen === 'approvals' && approvalCount > 0 && (
                    <span style={{
                      width: 20, height: 20,
                      borderRadius: '50%',
                      background: '#ff3b30',
                      color: '#fff',
                      fontSize: 11,
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}>
                      {approvalCount}
                    </span>
                  )}

                  {/* Active indicator */}
                  {isActive && (
                    <span style={{
                      width: 6, height: 6,
                      borderRadius: '50%',
                      background: '#ef4444',
                    }} />
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* Keyframes */}
      <style>{`
        @keyframes speedDialFade {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes speedDialSlide {
          from {
            opacity: 0;
            transform: translateY(-8px) scale(0.95);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
      `}</style>
    </div>
  );
});
