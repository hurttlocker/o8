'use client';

import type { CSSProperties, ReactNode } from 'react';
import {
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
  MobileSectionHeading,
  MobileStatusDot,
  MobileThreadListRoot,
  mobileSafeBottom,
} from './mobile-shell-primitives';

interface SidebarProps {
  open: boolean;
  activeView: MobileView;
  approvalCount: number;
  themeId: string;
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
  themeId,
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
      description: 'Recent conversations and live assistant threads.',
      icon: <IconChat fill={palette.iconFill} />,
    },
    {
      id: 'approvals',
      label: 'Approvals',
      description: 'Pending actions that require operator confirmation.',
      badge: approvalCount > 0 ? approvalCount : undefined,
      icon: <IconShield fill={palette.iconFill} />,
    },
    {
      id: 'settings',
      label: 'Settings',
      description: 'Theme, model, and transport controls.',
      icon: <IconGear fill={palette.iconFill} />,
    },
  ];

  const connectionColor = connectionStatus === 'connected' ? palette.success : palette.danger;

  const navButtonStyle = (active: boolean): CSSProperties => ({
    width: '100%',
    borderRadius: 20,
    border: `1px solid ${active ? palette.accentBorder : palette.cardBorder}`,
    background: active
      ? `linear-gradient(135deg, ${palette.accentSoft} 0%, ${palette.panelBackground} 100%)`
      : palette.cardBackground,
    padding: 16,
    color: palette.rootText,
    display: 'flex',
    alignItems: 'flex-start',
    gap: 14,
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: mobileFontFamily(),
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
          <MobileSectionHeading
            eyebrow="Mobile Command"
            title="o8"
            subtitle="Glass navigation for chats, approvals, and device controls."
            palette={palette}
            action={(
              <button
                type="button"
                onClick={onClose}
                style={{
                  minWidth: 56,
                  height: 36,
                  borderRadius: 999,
                  border: `1px solid ${palette.cardBorder}`,
                  background: palette.cardBackground,
                  color: palette.rootText,
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 700,
                  fontFamily: mobileFontFamily(),
                }}
              >
                Close
              </button>
            )}
          />
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
                    width: 42,
                    height: 42,
                    borderRadius: 16,
                    border: `1px solid ${active ? palette.accentBorder : palette.cardBorder}`,
                    background: active ? palette.panelBackground : palette.panelElevated,
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
                          color: palette.inverseIconFill,
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
              label="Theme"
              value={themeId === 'dark' ? 'Dark' : 'Light'}
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
              borderRadius: 18,
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
