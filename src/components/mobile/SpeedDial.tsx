'use client';

import { useState, useEffect, useRef, memo } from 'react';

export type MobileScreen = 'chat' | 'fleet' | 'memory' | 'approvals' | 'costs' | 'settings';

interface SpeedDialProps {
  activeScreen: MobileScreen;
  onNavigate: (screen: MobileScreen) => void;
  approvalCount?: number;
  alertCount?: number;
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

export const SpeedDial = memo(function SpeedDial({
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
    <div ref={menuRef} style={{
      position: 'fixed',
      bottom: 28,
      right: 20,
      zIndex: 9999,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: 0,
    }}>
      {/* Menu items — stacked above FAB */}
      {open && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 8,
          marginBottom: 12,
        }}>
          {MENU_ITEMS.map((item, index) => {
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
                  gap: 10,
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  animation: `speedDialIn 200ms ease ${index * 40}ms both`,
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                {/* Label pill */}
                <span style={{
                  padding: '8px 16px',
                  borderRadius: 20,
                  background: isActive ? '#1a1a1a' : 'rgba(0,0,0,0.85)',
                  backdropFilter: 'blur(20px)',
                  WebkitBackdropFilter: 'blur(20px)',
                  color: '#ffffff',
                  fontSize: 14,
                  fontWeight: 600,
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  letterSpacing: '-0.01em',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
                  position: 'relative',
                }}>
                  {item.label}
                  {/* Approval badge */}
                  {item.screen === 'approvals' && approvalCount > 0 && (
                    <span style={{
                      position: 'absolute',
                      top: -4,
                      right: -4,
                      width: 18, height: 18,
                      borderRadius: '50%',
                      background: '#ef4444',
                      color: '#fff',
                      fontSize: 10,
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}>
                      {approvalCount}
                    </span>
                  )}
                </span>

                {/* Icon circle */}
                <span style={{
                  width: 44, height: 44,
                  borderRadius: 14,
                  background: isActive ? '#1a1a1a' : 'rgba(0,0,0,0.85)',
                  backdropFilter: 'blur(20px)',
                  WebkitBackdropFilter: 'blur(20px)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
                  border: isActive ? '2px solid #ef4444' : '2px solid transparent',
                }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                    stroke={isActive ? '#ef4444' : '#ffffff'}
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d={item.iconPath} />
                  </svg>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* FAB trigger */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        style={{
          width: 52, height: 52,
          borderRadius: 16,
          background: open ? '#1a1a1a' : '#ef4444',
          border: 'none',
          color: '#ffffff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          boxShadow: open
            ? '0 4px 16px rgba(0,0,0,0.3)'
            : '0 4px 20px rgba(239,68,68,0.4)',
          transition: 'all 250ms cubic-bezier(0.32, 0.72, 0, 1)',
          transform: open ? 'rotate(45deg)' : 'rotate(0deg)',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>

      {/* Animation keyframes */}
      <style>{`
        @keyframes speedDialIn {
          from {
            opacity: 0;
            transform: translateY(10px) scale(0.9);
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
