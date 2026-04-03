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
        <MobileGlassPanel palette={palette} style={{ padding: 20, marginBottom: 14 }}>
          <MobileSectionHeading
            eyebrow="Chats"
            title="Recent conversations"
            subtitle="Open a saved thread, long-press for management actions, or start a fresh o8 mobile chat."
            palette={palette}
            action={(
              <div style={{ display: 'grid', gap: 8 }}>
                <MobilePillButton onClick={onRefresh} palette={palette}>
                  Refresh
                </MobilePillButton>
                <MobilePillButton onClick={onNewChat} palette={palette} tone="accent">
                  New chat
                </MobilePillButton>
              </div>
            )}
          />
        </MobileGlassPanel>

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
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    textAlign: 'left',
                    cursor: 'pointer',
                    fontFamily: mobileFontFamily(),
                    userSelect: 'none',
                    WebkitUserSelect: 'none',
                  }}
                >
                  <MobileGlassPanel palette={palette} style={{ padding: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 16, fontWeight: 800, color: palette.rootText, lineHeight: 1.3 }}>
                          {conversation.title || 'Untitled conversation'}
                        </div>
                        <div style={{ fontSize: 12, color: palette.subduedText, marginTop: 4 }}>
                          {chatTimeAgo(conversation.updatedAt)}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                        {conversation.starred ? (
                          <span
                            style={{
                              width: 30,
                              height: 30,
                              borderRadius: 999,
                              border: `1px solid ${palette.warningSoft}`,
                              background: palette.warningSoft,
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            <IconStar fill={palette.accent} size={14} />
                          </span>
                        ) : null}
                        {conversation.model ? (
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              minHeight: 28,
                              paddingLeft: 10,
                              paddingRight: 10,
                              borderRadius: 999,
                              border: `1px solid ${palette.cardBorder}`,
                              background: palette.cardBackground,
                              fontSize: 11,
                              fontWeight: 700,
                              color: palette.subduedText,
                            }}
                          >
                            {truncateText(conversation.model, 24)}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    <div
                      style={{
                        fontSize: 13,
                        lineHeight: 1.65,
                        letterSpacing: MOBILE_BODY_TRACKING,
                        color: palette.mutedText,
                        overflow: 'hidden',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                      } as CSSProperties}
                    >
                      {preview}
                    </div>
                  </MobileGlassPanel>
                </button>
              );
            })}
          </MobileThreadListRoot>
        )}
      </div>
    </MobileSurfaceRoot>
  );
}
