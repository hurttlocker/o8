'use client';

import { useCallback, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  IconCaretRight,
  IconChat,
  IconPencil,
  IconStar,
  IconTrash,
  MobilePalette,
  glassButtonStyle,
  mobileFontFamily,
  mobileCardStyle,
  type ChatHistoryRecord,
} from './mobile-approvals-shared';

interface ContextMenuState {
  tabId: string;
  title: string;
  starred?: boolean;
  x: number;
  y: number;
}

function chatTimeAgo(dateStr: string): string {
  const timestamp = new Date(dateStr).getTime();
  if (Number.isNaN(timestamp)) return '';

  const ms = Date.now() - timestamp;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
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
          left: Math.min(menu.x, typeof window !== 'undefined' ? window.innerWidth - 204 : 204),
          top: Math.min(menu.y, typeof window !== 'undefined' ? window.innerHeight - 210 : 420),
          zIndex: 1001,
          ...mobileCardStyle(palette, {
            background: palette.menuBackground,
            borderRadius: 18,
            minWidth: 184,
            padding: '6px 0',
          }),
        }}
      >
        {items.map((item) => (
          <button
            key={item.action}
            onClick={() => {
              onAction(item.action, menu.tabId);
              onClose();
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              width: '100%',
              padding: '12px 16px',
              border: 'none',
              backgroundColor: 'transparent',
              color: item.color ?? palette.rootText,
              fontSize: 15,
              fontWeight: 500,
              fontFamily: mobileFontFamily(),
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span style={{ opacity: item.color ? 1 : 0.85 }}>{item.icon}</span>
            {item.label}
          </button>
        ))}
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

  if (loading) {
    return (
      <div style={{ paddingTop: 64, textAlign: 'center', color: palette.subduedText, fontSize: 14 }}>
        Loading conversations...
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, overflowY: 'auto' }}>
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

      {conversations.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 100, color: palette.subduedText }}>
          <IconChat fill={palette.iconFill} style={{ opacity: 0.28 }} />
          <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4, marginTop: 16, color: palette.rootText }}>
            No conversations yet
          </div>
          <div style={{ fontSize: 13 }}>Use the add button to start a new chat.</div>
        </div>
      ) : (
        conversations.map((conversation) => (
          <div key={conversation.tabId}>
            {renaming === conversation.tabId ? (
              <div style={{ display: 'flex', gap: 8, padding: '10px 0', borderBottom: `1px solid ${palette.cardBorder}` }}>
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
                    flex: 1,
                    height: 42,
                    borderRadius: 14,
                    border: `1px solid ${palette.inputBorder}`,
                    backgroundColor: palette.inputBackground,
                    color: palette.rootText,
                    fontSize: 14,
                    paddingLeft: 12,
                    paddingRight: 12,
                    outline: 'none',
                    fontFamily: mobileFontFamily(),
                  }}
                />
                <button
                  onClick={() => {
                    void handleRenameSubmit();
                  }}
                  style={{
                    height: 42,
                    paddingLeft: 14,
                    paddingRight: 14,
                    borderRadius: 14,
                    border: `1px solid ${palette.accentBorder}`,
                    backgroundColor: palette.accent,
                    color: palette.inverseIconFill,
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: 'pointer',
                    fontFamily: mobileFontFamily(),
                  }}
                >
                  Save
                </button>
              </div>
            ) : (
              <button
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
                  display: 'flex',
                  alignItems: 'center',
                  width: '100%',
                  padding: '14px 0',
                  backgroundColor: 'transparent',
                  border: 'none',
                  borderBottom: `1px solid ${palette.cardBorder}`,
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: mobileFontFamily(),
                  userSelect: 'none',
                  WebkitUserSelect: 'none',
                } as CSSProperties}
              >
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: palette.rootText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {conversation.title || 'Untitled'}
                  </div>
                  <div style={{ fontSize: 12, color: palette.subduedText, marginTop: 3 }}>
                    {chatTimeAgo(conversation.updatedAt)}
                  </div>
                </div>
                <IconCaretRight fill={palette.iconFill} style={{ flexShrink: 0, marginLeft: 8, opacity: 0.4 }} />
              </button>
            )}
          </div>
        ))
      )}

      <button
        onClick={onNewChat}
        style={{
          position: 'fixed',
          bottom: 'max(env(safe-area-inset-bottom, 0px), 24px)',
          right: 24,
          ...glassButtonStyle(56, 'accent', true, palette),
          borderRadius: 20,
          fontSize: 28,
          fontWeight: 300,
          color: palette.rootText,
          fontFamily: mobileFontFamily(),
        } as CSSProperties}
        aria-label="New chat"
      >
        +
      </button>
    </div>
  );
}
