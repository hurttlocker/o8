'use client';

import type { CSSProperties, ReactNode } from 'react';
import {
  IconChat,
  IconGear,
  IconShield,
  MobilePalette,
  type ChatHistoryRecord,
  type MobileView,
  SIDEBAR_TITLE_MAX_LENGTH,
  SIDEBAR_WIDTH,
  mobileCardStyle,
  mobileFontFamily,
  truncateText,
} from './mobile-approvals-shared';

interface SidebarProps {
  open: boolean;
  activeView: MobileView;
  approvalCount: number;
  currentTabId: string | null;
  recentConversations: ChatHistoryRecord[];
  recentLoading: boolean;
  onNavigate: (view: MobileView) => void;
  onSelectConversation: (tabId: string) => void;
  onClose: () => void;
  palette: MobilePalette;
}

interface SidebarNavItem {
  id: MobileView;
  label: string;
  badge?: number;
  icon: ReactNode;
}

export function Sidebar({
  open,
  activeView,
  approvalCount,
  currentTabId,
  recentConversations,
  recentLoading,
  onNavigate,
  onSelectConversation,
  onClose,
  palette,
}: SidebarProps) {
  const navItems: SidebarNavItem[] = [
    {
      id: 'approvals',
      label: 'Approvals',
      badge: approvalCount > 0 ? approvalCount : undefined,
      icon: <IconShield fill={palette.iconFill} />,
    },
    {
      id: 'chat',
      label: 'Chat',
      icon: <IconChat fill={palette.iconFill} />,
    },
  ];

  const settingsButtonActive = activeView === 'settings';
  const sectionTitleStyle: CSSProperties = {
    marginTop: 20,
    marginBottom: 10,
    paddingLeft: 14,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: palette.subduedText,
    fontFamily: mobileFontFamily(),
  };

  const rowButtonStyle = (active: boolean): CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    minHeight: 48,
    padding: '12px 14px',
    borderRadius: 16,
    border: `1px solid ${active ? palette.accentBorder : 'transparent'}`,
    background: active ? palette.panelElevated : 'transparent',
    color: active ? palette.rootText : palette.mutedText,
    fontSize: 15,
    fontWeight: active ? 700 : 500,
    fontFamily: mobileFontFamily(),
    cursor: 'pointer',
    textAlign: 'left',
    marginBottom: 6,
    transition: 'background 0.18s ease, border-color 0.18s ease, color 0.18s ease',
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
          width: SIDEBAR_WIDTH,
          background: palette.sidebarBackground,
          backdropFilter: 'blur(30px) saturate(160%)',
          WebkitBackdropFilter: 'blur(30px) saturate(160%)',
          borderRight: `1px solid ${palette.cardBorder}`,
          boxShadow: palette.shadow,
          zIndex: 999,
          transform: open ? 'translateX(0)' : `translateX(-${SIDEBAR_WIDTH}px)`,
          transition: 'transform 0.28s cubic-bezier(0.32, 0.72, 0, 1)',
          paddingTop: 'max(env(safe-area-inset-top, 0px), 18px)',
          paddingLeft: 18,
          paddingRight: 18,
          display: 'flex',
          flexDirection: 'column',
          color: palette.rootText,
          fontFamily: mobileFontFamily(),
        } as CSSProperties}
      >
        <div
          style={{
            ...mobileCardStyle(palette, {
              padding: '16px 18px',
              marginBottom: 18,
              background: palette.panelElevated,
            }),
          }}
        >
          <div style={{ fontSize: 13, letterSpacing: '0.1em', textTransform: 'uppercase', color: palette.subduedText, marginBottom: 6 }}>
            Mobile Control
          </div>
          <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.04em', color: palette.rootText }}>
            o8
          </div>
        </div>

        <div style={{ display: 'grid', gap: 2 }}>
          {navItems.map((item) => {
            const active = activeView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  onNavigate(item.id);
                  onClose();
                }}
                style={rowButtonStyle(active)}
              >
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: active ? 1 : 0.82 }}>
                  {item.icon}
                </span>
                <span style={{ flex: 1 }}>{item.label}</span>
                {item.badge ? (
                  <span
                    style={{
                      minWidth: 22,
                      height: 22,
                      borderRadius: 999,
                      backgroundColor: palette.danger,
                      color: palette.inverseIconFill,
                      fontSize: 11,
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '0 7px',
                    }}
                  >
                    {item.badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingTop: 8, paddingBottom: 16 }}>
          {sectionTitleStyle && <div style={sectionTitleStyle}>Recent Chats</div>}
          {recentLoading ? (
            <div style={{ paddingLeft: 14, paddingRight: 14, fontSize: 13, color: palette.subduedText, lineHeight: 1.6 }}>
              Loading conversations...
            </div>
          ) : recentConversations.length === 0 ? (
            <div style={{ paddingLeft: 14, paddingRight: 14, fontSize: 13, color: palette.subduedText, lineHeight: 1.6 }}>
              No saved chats yet.
            </div>
          ) : (
            recentConversations.map((conversation) => {
              const active = currentTabId === conversation.tabId;
              const title = truncateText(conversation.title, SIDEBAR_TITLE_MAX_LENGTH);
              return (
                <button
                  key={conversation.tabId}
                  onClick={() => {
                    onSelectConversation(conversation.tabId);
                    onClose();
                  }}
                  style={{
                    width: '100%',
                    border: `1px solid ${active ? palette.accentBorder : 'transparent'}`,
                    background: active ? palette.panelElevated : 'transparent',
                    color: active ? palette.rootText : palette.mutedText,
                    borderRadius: 16,
                    textAlign: 'left',
                    padding: '11px 14px',
                    cursor: 'pointer',
                    marginBottom: 6,
                    transition: 'background 0.18s ease, border-color 0.18s ease, color 0.18s ease',
                    fontFamily: mobileFontFamily(),
                  }}
                >
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: active ? 700 : 500,
                      lineHeight: 1.4,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {title}
                  </div>
                </button>
              );
            })
          )}
        </div>

        <button
          onClick={() => {
            onNavigate('settings');
            onClose();
          }}
          style={{
            ...rowButtonStyle(settingsButtonActive),
            marginTop: 8,
            marginBottom: 'max(env(safe-area-inset-bottom, 0px), 18px)',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: settingsButtonActive ? 1 : 0.82 }}>
            <IconGear fill={palette.iconFill} />
          </span>
          <span style={{ flex: 1 }}>Settings</span>
        </button>
      </div>
    </>
  );
}
