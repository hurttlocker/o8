'use client';

import type { CSSProperties, ReactNode } from 'react';
import {
  MOBILE_BODY_TRACKING,
  MOBILE_CARD_RADIUS,
  MOBILE_HEADING_TRACKING,
  MOBILE_TOUCH_TARGET,
  IconChat,
  IconGear,
  IconShield,
  type MobilePalette,
  type MobileView,
  mobileFontFamily,
  renderConnectionLabel,
} from './mobile-approvals-shared';
import {
  MobileGlassPanel,
  MobileMetricChip,
  MobileStatusDot,
  MobileThreadListRoot,
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
    minHeight: MOBILE_TOUCH_TARGET * 2,
    borderRadius: MOBILE_CARD_RADIUS,
    border: `1px solid ${active ? palette.accentBorder : palette.cardBorder}`,
    background: active ? palette.accentSoft : palette.panelBackground,
    padding: 16,
    color: palette.rootText,
    display: 'flex',
    alignItems: 'flex-start',
    gap: 14,
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: mobileFontFamily(),
    letterSpacing: MOBILE_BODY_TRACKING,
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    transition: 'background 0.22s ease, border-color 0.22s ease, transform 0.22s ease',
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
        <MobileGlassPanel palette={palette} style={{ padding: 18 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, minWidth: 0 }}>
              <div
                style={{
                  width: MOBILE_TOUCH_TARGET,
                  height: MOBILE_TOUCH_TARGET,
                  borderRadius: MOBILE_CARD_RADIUS,
                  border: `1px solid ${palette.accentBorder}`,
                  background: 'rgba(37, 99, 235, 0.22)',
                  color: palette.rootText,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 17,
                  fontWeight: 800,
                  letterSpacing: MOBILE_HEADING_TRACKING,
                  flexShrink: 0,
                }}
              >
                o8
              </div>
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    color: palette.subduedText,
                    marginBottom: 6,
                  }}
                >
                  o8 mobile
                </div>
                <div
                  style={{
                    fontSize: 23,
                    fontWeight: 800,
                    lineHeight: 1.05,
                    letterSpacing: MOBILE_HEADING_TRACKING,
                    color: palette.rootText,
                  }}
                >
                  Command Deck
                </div>
                <div
                  style={{
                    fontSize: 13,
                    lineHeight: 1.6,
                    letterSpacing: MOBILE_BODY_TRACKING,
                    color: palette.subduedText,
                    marginTop: 8,
                  }}
                >
                  Branded navigation for chats, approvals, and runtime controls.
                </div>
              </div>
            </div>
            <div style={{ flexShrink: 0 }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  width: MOBILE_TOUCH_TARGET,
                  height: MOBILE_TOUCH_TARGET,
                  borderRadius: MOBILE_CARD_RADIUS,
                  border: `1px solid ${palette.cardBorder}`,
                  background: palette.panelBackground,
                  color: palette.rootText,
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: MOBILE_BODY_TRACKING,
                  fontFamily: mobileFontFamily(),
                }}
              >
                Done
              </button>
            </div>
          </div>
        </MobileGlassPanel>

        <MobileThreadListRoot style={{ gap: 10 }}>
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
                <div
                  style={{
                    width: MOBILE_TOUCH_TARGET,
                    height: MOBILE_TOUCH_TARGET,
                    borderRadius: MOBILE_CARD_RADIUS,
                    border: `1px solid ${active ? palette.accentBorder : palette.cardBorder}`,
                    background: active ? 'rgba(37, 99, 235, 0.2)' : palette.cardBackground,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {item.icon}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      marginBottom: 6,
                    }}
                  >
                    <span style={{ fontSize: 16, fontWeight: 700, color: palette.rootText }}>
                      {item.label}
                    </span>
                    {item.badge ? (
                      <span
                        style={{
                          minWidth: 24,
                          height: 24,
                          borderRadius: 999,
                          paddingLeft: 8,
                          paddingRight: 8,
                          backgroundColor: palette.danger,
                          color: '#ffffff',
                          fontSize: 11,
                          fontWeight: 700,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {item.badge}
                      </span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.55, color: palette.subduedText }}>
                    {item.description}
                  </div>
                </div>
              </button>
            );
          })}
        </MobileThreadListRoot>

        <MobileGlassPanel palette={palette} style={{ padding: 18, marginTop: 'auto' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 10,
              marginBottom: 14,
            }}
          >
            <MobileMetricChip
              label="Palette"
              value="o8 Dark"
              palette={palette}
              tone="accent"
            />
            <MobileMetricChip
              label="Model"
              value={selectedModelLabel}
              palette={palette}
            />
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              borderRadius: MOBILE_CARD_RADIUS,
              border: `1px solid ${connectionStatus === 'connected' ? palette.successBorder : palette.dangerBorder}`,
              background: connectionStatus === 'connected' ? palette.successSoft : palette.dangerSoft,
              padding: '12px 14px',
            }}
          >
            <div>
              <div style={{ fontSize: 12, color: palette.subduedText, marginBottom: 4 }}>
                Transport
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, color: palette.rootText }}>
                WebSocket Bridge
              </div>
            </div>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                fontWeight: 700,
                color: palette.rootText,
              }}
            >
              <MobileStatusDot color={connectionColor} />
              {renderConnectionLabel(connectionStatus)}
            </span>
          </div>
        </MobileGlassPanel>
      </div>
    </>
  );
}
