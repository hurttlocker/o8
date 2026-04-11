'use client';

import { useState, memo, type CSSProperties } from 'react';
import { useTheme } from './ThemeContext';

export type MobileScreen = 'chat' | 'fleet' | 'approvals' | 'costs' | 'settings' | 'issues';

interface SpeedDialProps {
  activeScreen: MobileScreen;
  onNavigate: (screen: MobileScreen) => void;
  onNewChat?: () => void;
  approvalCount?: number;
  enabledViews: ReadonlySet<string>;
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
const SCREEN_TO_VIEW: Record<MobileScreen, string> = {
  chat: 'chat',
  fleet: 'fleet',
  approvals: 'activity',
  costs: 'costs',
  settings: 'settings',
  issues: 'issues',
};

const menuFontFamily = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif";
const menuBackground = 'rgba(38,36,34,0.95)';
const menuText = '#FAF5F0';
const menuTextSecondary = '#A09890';
const menuActiveBackground = 'rgba(255,248,240,0.06)';
const menuBorder = 'rgba(255,248,240,0.08)';
const menuSeparator = 'rgba(255,248,240,0.04)';

export const SpeedDialButton = memo(function SpeedDialButton({
  activeScreen,
  onNavigate,
  onNewChat,
  approvalCount = 0,
  enabledViews,
}: SpeedDialProps) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const primaryText = colors.text;
  const surfaceBorder = colors.surfaceBorder;
  const approvalBadgeBackground = colors.red;
  const closedBackground = colors.surface;
  const openBackground = 'rgba(30, 28, 26, 0.88)';
  const wrapperStyle: CSSProperties = {
    position: 'relative',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    zIndex: open ? 201 : undefined,
  };
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
      ? '0 14px 30px rgba(0, 0, 0, 0.30)'
      : '0 10px 24px rgba(0, 0, 0, 0.22)',
    transition: 'background 220ms ease, box-shadow 220ms ease, transform 180ms ease',
    WebkitTapHighlightColor: 'transparent',
    position: 'relative',
    padding: 0,
    zIndex: 201,
  };
  const backdropStyle: CSSProperties = {
    position: 'fixed',
    top: '-100dvh',
    left: '-100dvw',
    width: '300dvw',
    height: '300dvh',
    background: 'transparent',
    zIndex: 199,
  };
  const menuStyle: CSSProperties = {
    position: 'absolute',
    top: 52,
    left: 0,
    width: 220,
    background: menuBackground,
    backdropFilter: 'blur(40px)',
    WebkitBackdropFilter: 'blur(40px)',
    borderRadius: 14,
    border: `1px solid ${menuBorder}`,
    boxShadow: '0 24px 48px rgba(0,0,0,0.4)',
    overflow: 'hidden',
    boxSizing: 'border-box',
    zIndex: 200,
  };
  const menuItemStyle: CSSProperties = {
    width: '100%',
    minHeight: 44,
    padding: '12px 16px',
    border: 'none',
    background: 'transparent',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    color: menuText,
    cursor: 'pointer',
    textAlign: 'left',
    boxSizing: 'border-box',
    WebkitTapHighlightColor: 'transparent',
    touchAction: 'manipulation',
  };
  const separatorStyle: CSSProperties = {
    marginLeft: 48,
    borderTop: `1px solid ${menuSeparator}`,
  };
  const menuEntries: Array<{
    key: string;
    label: string;
    iconPath: string;
    isActive: boolean;
    onSelect: () => void;
  }> = [
    ...(onNewChat ? [{
      key: 'new-chat',
      label: 'New Chat',
      iconPath: 'M12 5v14 M5 12h14',
      isActive: false,
      onSelect: onNewChat,
    }] : []),
    ...MENU_ITEMS
      .filter((item) => enabledViews.has(SCREEN_TO_VIEW[item.screen]))
      .map((item) => ({
      key: item.screen,
      label: item.label,
      iconPath: item.iconPath,
      isActive: item.screen === activeScreen,
      onSelect: () => onNavigate(item.screen),
      })),
  ];

  return (
    <div style={wrapperStyle}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-label={approvalCount > 0 ? `Navigation menu, ${approvalCount} pending approvals` : 'Navigation menu'}
        aria-expanded={open}
        aria-haspopup="menu"
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

        {approvalCount > 0 && (
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

      {open ? (
        <>
          <div
            onClick={() => setOpen(false)}
            style={backdropStyle}
          />

          <div role="menu" aria-label="Navigation menu" style={menuStyle}>
            {menuEntries.map((item, index) => (
              <div key={item.key}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    item.onSelect();
                    setOpen(false);
                  }}
                  style={{
                    ...menuItemStyle,
                    background: item.isActive ? menuActiveBackground : 'transparent',
                  }}
                >
                  <span style={{
                    width: 20,
                    height: 20,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    color: item.isActive ? menuText : menuTextSecondary,
                  }}>
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d={item.iconPath} />
                    </svg>
                  </span>
                  <span style={{
                    flex: 1,
                    minWidth: 0,
                    color: menuText,
                    fontSize: 15,
                    fontWeight: 500,
                    fontFamily: menuFontFamily,
                    letterSpacing: '-0.01em',
                  }}>
                    {item.label}
                  </span>
                </button>
                {index < menuEntries.length - 1 ? <div style={separatorStyle} /> : null}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
});
