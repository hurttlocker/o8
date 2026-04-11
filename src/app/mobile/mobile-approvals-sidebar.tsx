'use client';

import type { CSSProperties, ReactNode } from 'react';
import {
  MOBILE_BODY_TRACKING,
  MOBILE_HEADING_TRACKING,
  MOBILE_TOUCH_TARGET,
  IconChat,
  IconGear,
  IconShield,
  type MobilePalette,
  type MobileView,
  mobileFontFamily,
} from './mobile-approvals-shared';
import {
  MobileStatusDot,
  mobileSafeBottom,
} from './mobile-shell-primitives';

interface SidebarProps {
  open: boolean;
  activeView: MobileView;
  approvalCount: number;
  selectedModelLabel: string;
  connectionStatus: 'connected' | 'disconnected';
  onNavigate: (view: MobileView) => void;
  onClose: () => void;
  palette: MobilePalette;
}

interface SidebarNavItem {
  id: MobileView;
  label: string;
  description: string;
  badge?: number;
  icon: ReactNode;
}

export function Sidebar({
  open,
  activeView,
  approvalCount,
  selectedModelLabel,
  connectionStatus,
  onNavigate,
  onClose,
  palette,
}: SidebarProps) {
  const navItems: SidebarNavItem[] = [
    {
      id: 'chat',
      label: 'Chats',
      description: 'Recent threads, live replies, and saved mobile sessions.',
      icon: <IconChat fill={palette.iconFill} />,
    },
    {
      id: 'approvals',
      label: 'Approvals',
      description: 'Operator actions that need a fast, explicit decision.',
      badge: approvalCount > 0 ? approvalCount : undefined,
      icon: <IconShield fill={palette.iconFill} />,
    },
    {
      id: 'settings',
      label: 'Settings',
      description: 'Model, transport, and shell status controls.',
      icon: <IconGear fill={palette.iconFill} />,
    },
  ];

  const connectionColor = connectionStatus === 'connected' ? palette.success : palette.danger;

  const navButtonStyle = (active: boolean): CSSProperties => ({
    width: '100%',
    height: MOBILE_TOUCH_TARGET,
    borderRadius: 10,
    border: 'none',
    background: active ? palette.accentSoft : 'transparent',
    paddingLeft: 12,
    paddingRight: 12,
    color: palette.rootText,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: mobileFontFamily(),
    letterSpacing: MOBILE_BODY_TRACKING,
  });

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: palette.overlayBackground,
          zIndex: 998,
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 0.24s ease',
        }}
      />

      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          bottom: 0,
          width: 296,
          paddingTop: 'max(env(safe-area-inset-top, 0px), 18px)',
          paddingLeft: 16,
          paddingRight: 16,
          paddingBottom: mobileSafeBottom(18),
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          background: palette.sidebarBackground,
          borderRight: `1px solid ${palette.cardBorder}`,
          boxShadow: palette.shadow,
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          zIndex: 999,
          transform: open ? 'translateX(0)' : 'translateX(-304px)',
          transition: 'transform 0.26s cubic-bezier(0.32, 0.72, 0, 1)',
          color: palette.rootText,
          fontFamily: mobileFontFamily(),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 2px' }}>
          <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: MOBILE_HEADING_TRACKING, color: palette.rootText }}>
            o8
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              height: 32,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 10,
              border: `1px solid ${palette.cardBorder}`,
              background: palette.panelBackground,
              color: palette.subduedText,
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
              fontFamily: mobileFontFamily(),
            }}
          >
            Done
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {navItems.map((item) => {
            const active = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onNavigate(item.id);
                  onClose();
                }}
                style={navButtonStyle(active)}
              >
                {item.icon}
                <span style={{ flex: 1, fontSize: 15, fontWeight: active ? 700 : 500, color: active ? palette.rootText : palette.mutedText }}>
                  {item.label}
                </span>
                {item.badge ? (
                  <span
                    style={{
                      minWidth: 20,
                      height: 20,
                      borderRadius: 999,
                      paddingLeft: 6,
                      paddingRight: 6,
                      backgroundColor: palette.danger,
                      color: '#ffffff',
                      fontSize: 10,
                      fontWeight: 700,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {item.badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div style={{ marginTop: 'auto', padding: '0 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: palette.subduedText }}>
            <MobileStatusDot color={connectionColor} />
            <span>{selectedModelLabel}</span>
          </div>
        </div>
      </div>
    </>
  );
}
