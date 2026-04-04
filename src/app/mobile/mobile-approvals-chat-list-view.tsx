'use client';

import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  IconChat,
  IconPencil,
  IconStar,
  IconTrash,
  MOBILE_BODY_TRACKING,
  MOBILE_CARD_RADIUS,
  MOBILE_HEADING_TRACKING,
  mobileFontFamily,
  truncateText,
  type ChatHistoryRecord,
  type MobilePalette,
} from './mobile-approvals-shared';
import {
  MobileGlassPanel,
  MobilePillButton,
  MobileSectionHeading,
  MobileSurfaceRoot,
  MobileThreadListRoot,
  mobileSafeBottom,
} from './mobile-shell-primitives';

interface ContextMenuState {
  tabId: string;
  title: string;
  starred?: boolean;
  x: number;
  y: number;
}

function chatTimeAgo(dateStr: string): string {
  const timestamp = new Date(dateStr).getTime();
  if (Number.isNaN(timestamp)) return 'Unknown';

  const ms = Date.now() - timestamp;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;

  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function ChatContextMenu({
  menu,
  onClose,
  onAction,
  palette,
}: {
  menu: ContextMenuState;
  onClose: () => void;
  onAction: (action: 'star' | 'rename' | 'delete', tabId: string) => void;
  palette: MobilePalette;
}) {
  const items: Array<{ action: 'star' | 'rename' | 'delete'; label: string; color?: string; icon: ReactNode }> = [
    {
      action: 'star',
      label: menu.starred ? 'Unstar' : 'Star',
      icon: <IconStar fill={palette.iconFill} />,
    },
    {
      action: 'rename',
      label: 'Rename',
      icon: <IconPencil fill={palette.iconFill} />,
    },
    {
      action: 'delete',
      label: 'Delete',
      color: palette.danger,
      icon: <IconTrash fill={palette.iconFill} />,
    },
  ];

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000 }} />
      <div
        style={{
          position: 'fixed',
          left: Math.min(menu.x, typeof window !== 'undefined' ? window.innerWidth - 208 : 208),
          top: Math.min(menu.y, typeof window !== 'undefined' ? window.innerHeight - 220 : 420),
          zIndex: 1001,
          width: 192,
        }}
      >
        <MobileGlassPanel palette={palette} style={{ padding: '6px 0', background: palette.menuBackground }}>
          {items.map((item) => (
            <button
              key={item.action}
              type="button"
              onClick={() => {
                onAction(item.action, menu.tabId);
                onClose();
              }}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 16px',
                border: 'none',
                backgroundColor: 'transparent',
                color: item.color ?? palette.rootText,
                fontSize: 15,
                fontWeight: 500,
                letterSpacing: MOBILE_BODY_TRACKING,
                textAlign: 'left',
                cursor: 'pointer',
                fontFamily: mobileFontFamily(),
              }}
            >
              <span style={{ opacity: item.color ? 1 : 0.88 }}>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </MobileGlassPanel>
      </div>
    </>
  );
}

export function ChatListView({
  conversations,
  loading,
  onSelect,
  onNewChat,
  onRefresh,
  palette,
}: {
  conversations: ChatHistoryRecord[];
  loading: boolean;
  onSelect: (tabId: string) => void;
  onNewChat: () => void;
  onRefresh: () => void;
  palette: MobilePalette;
}) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleLongPressStart = useCallback((
    tabId: string,
    title: string,
    starred: boolean,
    event: React.TouchEvent | React.MouseEvent,
  ) => {
    const clientX = 'touches' in event ? event.touches[0].clientX : event.clientX;
    const clientY = 'touches' in event ? event.touches[0].clientY : event.clientY;

    longPressTimer.current = setTimeout(() => {
      setContextMenu({ tabId, title, starred, x: clientX, y: clientY });
    }, 500);
  }, []);

  const handleLongPressEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handleContextAction = useCallback(async (action: 'star' | 'rename' | 'delete', tabId: string) => {
    if (action === 'delete') {
      await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(tabId)}`, { method: 'DELETE' });
      onRefresh();
      return;
    }

    if (action === 'star') {
      const existing = conversations.find((conversation) => conversation.tabId === tabId);
      await fetch('/api/v2/chat-history', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId, starred: !existing?.starred }),
      });
      onRefresh();
      return;
    }

    const conversation = conversations.find((item) => item.tabId === tabId);
    setRenaming(tabId);
    setRenameValue(conversation?.title ?? '');
  }, [conversations, onRefresh]);

  const handleRenameSubmit = useCallback(async () => {
    if (!renaming || !renameValue.trim()) {
      setRenaming(null);
      return;
    }

    await fetch('/api/v2/chat-history', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId: renaming, title: renameValue.trim() }),
    });

    setRenaming(null);
    onRefresh();
  }, [onRefresh, renameValue, renaming]);

  return (
    <MobileSurfaceRoot>
      {contextMenu ? (
        <ChatContextMenu
          menu={contextMenu}
          onClose={() => setContextMenu(null)}
          onAction={(action, tabId) => {
            void handleContextAction(action, tabId);
          }}
          palette={palette}
        />
      ) : null}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          paddingBottom: mobileSafeBottom(24),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px', marginBottom: 10 }}>
          <button
            type="button"
            onClick={onRefresh}
            style={{ border: 'none', background: 'transparent', color: palette.subduedText, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: mobileFontFamily(), padding: 0 }}
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={onNewChat}
            style={{ border: 'none', background: palette.accentSoft, color: palette.accent, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: mobileFontFamily(), padding: '6px 14px', borderRadius: 10 }}
          >
            New chat
          </button>
        </div>

        {loading ? (
          <MobileGlassPanel palette={palette} style={{ padding: '28px 20px', textAlign: 'center' }}>
            <div style={{ fontSize: 14, color: palette.subduedText }}>
              Loading conversations...
            </div>
          </MobileGlassPanel>
        ) : conversations.length === 0 ? (
          <MobileGlassPanel
            palette={palette}
            style={{
              padding: '44px 20px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
            }}
          >
            <IconChat fill={palette.iconFill} style={{ opacity: 0.3 }} />
            <div style={{ fontSize: 20, fontWeight: 800, color: palette.rootText, letterSpacing: MOBILE_HEADING_TRACKING, marginTop: 16, marginBottom: 6 }}>
              No conversations yet
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.7, letterSpacing: MOBILE_BODY_TRACKING, color: palette.subduedText, maxWidth: 280, marginBottom: 18 }}>
              Start a new chat and it will appear here once the first exchange is saved.
            </div>
            <MobilePillButton onClick={onNewChat} palette={palette} tone="accent">
              Start new chat
            </MobilePillButton>
          </MobileGlassPanel>
        ) : (
          <MobileThreadListRoot>
            {conversations.map((conversation) => {
              const preview = truncateText(conversation.lastMessage || 'No preview yet.', 140);

              if (renaming === conversation.tabId) {
                return (
                  <MobileGlassPanel key={conversation.tabId} palette={palette} style={{ padding: 16 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: palette.rootText, marginBottom: 10 }}>
                      Rename conversation
                    </div>
                    <div style={{ display: 'grid', gap: 10 }}>
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            void handleRenameSubmit();
                          }
                          if (event.key === 'Escape') {
                            setRenaming(null);
                          }
                        }}
                        style={{
                          height: 44,
                          borderRadius: MOBILE_CARD_RADIUS,
                          border: `1px solid ${palette.inputBorder}`,
                          backgroundColor: palette.inputBackground,
                          color: palette.rootText,
                          fontSize: 14,
                          letterSpacing: MOBILE_BODY_TRACKING,
                          paddingLeft: 12,
                          paddingRight: 12,
                          outline: 'none',
                          fontFamily: mobileFontFamily(),
                        }}
                      />
                      <div style={{ display: 'flex', gap: 10 }}>
                        <MobilePillButton onClick={() => setRenaming(null)} palette={palette} style={{ flex: 1 }}>
                          Cancel
                        </MobilePillButton>
                        <MobilePillButton
                          onClick={() => {
                            void handleRenameSubmit();
                          }}
                          palette={palette}
                          tone="accent"
                          style={{ flex: 1 }}
                        >
                          Save
                        </MobilePillButton>
                      </div>
                    </div>
                  </MobileGlassPanel>
                );
              }

              return (
                <button
                  key={conversation.tabId}
                  type="button"
                  onClick={() => {
                    if (!contextMenu) onSelect(conversation.tabId);
                  }}
                  onMouseDown={(event) => handleLongPressStart(conversation.tabId, conversation.title, conversation.starred ?? false, event)}
                  onMouseUp={handleLongPressEnd}
                  onMouseLeave={handleLongPressEnd}
                  onTouchStart={(event) => handleLongPressStart(conversation.tabId, conversation.title, conversation.starred ?? false, event)}
                  onTouchEnd={handleLongPressEnd}
                  onTouchMove={handleLongPressEnd}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({
                      tabId: conversation.tabId,
                      title: conversation.title,
                      starred: conversation.starred,
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                  style={{
                    width: '100%',
                    height: 56,
                    paddingLeft: 14,
                    paddingRight: 14,
                    border: 'none',
                    borderBottom: `1px solid ${palette.cardBorder}`,
                    background: 'transparent',
                    textAlign: 'left',
                    cursor: 'pointer',
                    fontFamily: mobileFontFamily(),
                    userSelect: 'none',
                    WebkitUserSelect: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: palette.rootText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {conversation.starred ? (
                        <IconStar fill={palette.warning} size={12} style={{ marginRight: 6, verticalAlign: -1 } as React.CSSProperties} />
                      ) : null}
                      {conversation.title || 'Untitled'}
                    </div>
                    <div style={{ fontSize: 11, color: palette.subduedText, marginTop: 2 }}>
                      {chatTimeAgo(conversation.updatedAt)}
                      {conversation.model ? (
                        <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: palette.subduedText }}>
                            {truncateText(conversation.model, 24)}
                          </span>
                        ) : null}
                      </div>
                    </div>
                </button>
              );
            })}
          </MobileThreadListRoot>
        )}
      </div>
    </MobileSurfaceRoot>
  );
}
