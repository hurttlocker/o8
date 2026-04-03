'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MobileMarkdown } from './mobile-markdown';

// ── Types ──

type MobileView = 'approvals' | 'chat';

interface ApprovalItem {
  id: string;
  title: string;
  description?: string;
  summary?: string;
  risk: 'low' | 'medium' | 'high';
  source?: 'llm-chat' | 'runtime' | 'test';
  toolName?: string;
  sessionKey?: string;
  status: string;
  createdAt: number;
  metadata?: Record<string, string>;
  continuation?: { kind: 'llm-chat' | 'runtime' | 'lane' };
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatHistoryRecord {
  tabId: string;
  title: string;
  lastMessage: string;
  updatedAt: string;
  model?: string;
}

// ── Constants ──

const RISK_COLORS: Record<string, string> = { high: '#ef4444', medium: '#f59e0b', low: '#22c55e' };
const POLL_INTERVAL = 5_000;
const SIDEBAR_WIDTH = 280;
const MOBILE_CHAT_MODEL = 'gemini-2.5-flash';
const MOBILE_CHAT_STORAGE_KEY = 'o8-mobile-chat-tab';
const MAX_RECENT_CONVERSATIONS = 10;
const CHAT_TITLE_MAX_LENGTH = 50;
const SIDEBAR_TITLE_MAX_LENGTH = 40;

// ── Helpers ──

function isGovernanceApproval(a: ApprovalItem): boolean {
  if (a.continuation?.kind === 'lane') return true;
  if (a.risk === 'high') return true;
  if (a.source === 'llm-chat' || a.continuation?.kind === 'llm-chat') return false;
  if (a.source === 'test') return false;
  return true;
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function generateChatTabId(): string {
  if (typeof window !== 'undefined' && typeof window.crypto?.randomUUID === 'function') {
    return `mobile-chat-${window.crypto.randomUUID()}`;
  }
  return `mobile-chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function extractMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('\n')
      .trim();
  }
  if (content && typeof content === 'object' && 'text' in content && typeof content.text === 'string') {
    return content.text;
  }
  return '';
}

function normalizeChatMessages(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) return [];

  return messages.reduce<ChatMessage[]>((acc, message) => {
    if (!message || typeof message !== 'object') return acc;
    const role = 'role' in message ? message.role : undefined;
    if (role !== 'user' && role !== 'assistant') return acc;
    const content = extractMessageContent('content' in message ? message.content : '');
    acc.push({ role, content });
    return acc;
  }, []);
}

function getConversationTitle(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === 'user');
  return truncateText(firstUserMessage?.content ?? 'Untitled conversation', CHAT_TITLE_MAX_LENGTH);
}

function normalizeHistoryList(data: unknown): ChatHistoryRecord[] {
  if (!data || typeof data !== 'object') return [];

  const items = 'items' in data && Array.isArray(data.items)
    ? data.items
    : ('conversations' in data && Array.isArray(data.conversations) ? data.conversations : []);

  return items.reduce<ChatHistoryRecord[]>((acc, item) => {
    if (!item || typeof item !== 'object') return acc;
    const tabId = 'tabId' in item && typeof item.tabId === 'string' ? item.tabId : '';
    if (!tabId) return acc;
    const title = 'title' in item && typeof item.title === 'string' && item.title.trim()
      ? item.title
      : 'Untitled conversation';
    const lastMessage = 'lastMessage' in item && typeof item.lastMessage === 'string'
      ? item.lastMessage
      : ('preview' in item && typeof item.preview === 'string' ? item.preview : '');
    const updatedAt = 'updatedAt' in item && typeof item.updatedAt === 'string'
      ? item.updatedAt
      : ('modifiedAt' in item && typeof item.modifiedAt === 'string' ? item.modifiedAt : '');
    const model = 'model' in item && typeof item.model === 'string' ? item.model : undefined;

    acc.push({ tabId, title, lastMessage, updatedAt, model });
    return acc;
  }, [])
    .slice(0, MAX_RECENT_CONVERSATIONS);
}

// ── Icons (Phosphor thin, raw SVG paths) ──

function IconHamburger() {
  return (
    <svg width="22" height="22" viewBox="0 0 256 256" fill="currentColor">
      <path d="M224,128a8,8,0,0,1-8,8H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,128ZM40,72H216a8,8,0,0,0,0-16H40a8,8,0,0,0,0,16ZM216,184H40a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Z" />
    </svg>
  );
}

function IconShield() {
  return (
    <svg width="20" height="20" viewBox="0 0 256 256" fill="currentColor">
      <path d="M208,40H48A16,16,0,0,0,32,56v56c0,52.72,25.52,84.67,46.93,102.19,23.06,18.86,46,26.61,47.17,27a8,8,0,0,0,5.8,0c1.21-.42,24.11-8.17,47.17-27C200.48,196.67,224,164.72,224,112V56A16,16,0,0,0,208,40Zm0,72c0,37.07-13.66,65.49-40.6,84.44a155.07,155.07,0,0,1-39.4,22.2,155.07,155.07,0,0,1-39.4-22.2C61.66,177.49,48,149.07,48,112V56H208Z" />
    </svg>
  );
}

function IconChat() {
  return (
    <svg width="20" height="20" viewBox="0 0 256 256" fill="currentColor">
      <path d="M216,48H40A16,16,0,0,0,24,64V224a15.84,15.84,0,0,0,9.25,14.5A16.05,16.05,0,0,0,40,240a15.89,15.89,0,0,0,10.25-3.78l.09-.07L83,208H216a16,16,0,0,0,16-16V64A16,16,0,0,0,216,48Zm0,144H83a8,8,0,0,0-5.13,1.86L40,224V64H216Z" />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg width="18" height="18" viewBox="0 0 256 256" fill="currentColor">
      <path d="M228,48V96a4,4,0,0,1-4,4H176a4,4,0,0,1,0-8h39.37L184.2,60.84a92,92,0,0,0-152.37,18,4,4,0,1,1-7.31-3.24A100,100,0,0,1,189.94,55.94L220,86.06V48a4,4,0,0,1,8,0ZM231.48,180.36a100,100,0,0,1-165.42,19.7L36,170.06V208a4,4,0,0,1-8,0V160a4,4,0,0,1,4-4H80a4,4,0,0,1,0,8H40.63l31.17,31.16A92,92,0,0,0,224.17,177.2a4,4,0,1,1,7.31,3.16Z" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="48" height="48" viewBox="0 0 256 256" fill="currentColor" style={{ opacity: 0.4 }}>
      <path d="M172.24,99.76a4,4,0,0,1,0,5.66l-56,56a4,4,0,0,1-5.66,0l-24-24a4,4,0,0,1,5.66-5.66L113.48,153l53.17-53.17A4,4,0,0,1,172.24,99.76ZM228,128A100,100,0,1,1,128,28,100.11,100.11,0,0,1,228,128Zm-8,0a92,92,0,1,0-92,92A92.1,92.1,0,0,0,220,128Z" />
    </svg>
  );
}

function IconSend() {
  return (
    <svg width="20" height="20" viewBox="0 0 256 256" fill="currentColor">
      <path d="M231.87,114,25.66,14.16a8,8,0,0,0-11,9.48L40.46,120H136a8,8,0,0,1,0,16H40.46L14.63,232.36A8,8,0,0,0,22,240a8.14,8.14,0,0,0,3.68-.89L231.87,142A8,8,0,0,0,231.87,114Z" />
    </svg>
  );
}

function StreamingDot() {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setExpanded((value) => !value);
    }, 720);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <span
      aria-label="Assistant is responding"
      style={{
        width: 9,
        height: 9,
        borderRadius: '50%',
        backgroundColor: '#60a5fa',
        boxShadow: expanded ? '0 0 0 7px rgba(96,165,250,0.08)' : '0 0 0 2px rgba(96,165,250,0.04)',
        display: 'inline-block',
        opacity: expanded ? 1 : 0.48,
        transform: expanded ? 'scale(1)' : 'scale(0.72)',
        transformOrigin: 'center',
        transition: 'opacity 0.6s ease, transform 0.6s ease, box-shadow 0.6s ease',
      }}
    />
  );
}

// ── Sidebar ──

function Sidebar({
  open,
  activeView,
  approvalCount,
  currentTabId,
  recentConversations,
  recentLoading,
  onNavigate,
  onSelectConversation,
  onClose,
}: {
  open: boolean;
  activeView: MobileView;
  approvalCount: number;
  currentTabId: string | null;
  recentConversations: ChatHistoryRecord[];
  recentLoading: boolean;
  onNavigate: (view: MobileView) => void;
  onSelectConversation: (tabId: string) => void;
  onClose: () => void;
}) {
  const items: Array<{ id: MobileView; label: string; icon: React.ReactNode; badge?: number }> = [
    { id: 'approvals', label: 'Approvals', icon: <IconShield />, badge: approvalCount > 0 ? approvalCount : undefined },
    { id: 'chat', label: 'Chat', icon: <IconChat /> },
  ];

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0,0,0,0.5)',
          zIndex: 998,
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 0.25s ease',
        }}
      />
      {/* Drawer */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          bottom: 0,
          width: SIDEBAR_WIDTH,
          backgroundColor: '#1a1a1a',
          zIndex: 999,
          transform: open ? 'translateX(0)' : `translateX(-${SIDEBAR_WIDTH}px)`,
          transition: 'transform 0.28s cubic-bezier(0.32, 0.72, 0, 1)',
          paddingTop: 'max(env(safe-area-inset-top, 0px), 20px)',
          paddingLeft: 20,
          paddingRight: 20,
          display: 'flex',
          flexDirection: 'column',
        } as React.CSSProperties}
      >
        {/* Title */}
        <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.03em', color: '#f3f4f6', marginBottom: 28 }}>
          o8
        </div>

        <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 16px)' }}>
          {/* Nav items */}
          {items.map((item) => {
            const active = activeView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  onNavigate(item.id);
                  onClose();
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  width: '100%',
                  height: 48,
                  paddingLeft: 14,
                  paddingRight: 14,
                  borderRadius: 12,
                  border: 'none',
                  backgroundColor: active ? 'rgba(255,255,255,0.1)' : 'transparent',
                  color: active ? '#f3f4f6' : '#9ca3af',
                  fontSize: 16,
                  fontWeight: active ? 600 : 400,
                  fontFamily: 'system-ui, -apple-system, sans-serif',
                  cursor: 'pointer',
                  textAlign: 'left',
                  marginBottom: 4,
                  transition: 'background-color 0.15s ease',
                }}
              >
                {item.icon}
                <span style={{ flex: 1 }}>{item.label}</span>
                {item.badge && (
                  <span
                    style={{
                      minWidth: 20,
                      height: 20,
                      borderRadius: 10,
                      backgroundColor: '#ef4444',
                      color: '#fff',
                      fontSize: 11,
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '0 6px',
                    }}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}

          <div
            style={{
              marginTop: 20,
              marginBottom: 10,
              paddingLeft: 14,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: '#6b7280',
            }}
          >
            Recents
          </div>

          {recentLoading ? (
            <div style={{ paddingLeft: 14, paddingRight: 14, fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
              Loading conversations...
            </div>
          ) : recentConversations.length > 0 ? (
            recentConversations.map((conversation) => {
              const activeConversation = currentTabId === conversation.tabId;
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
                    border: 'none',
                    backgroundColor: activeConversation ? 'rgba(37,99,235,0.14)' : 'transparent',
                    color: activeConversation ? '#f3f4f6' : '#d1d5db',
                    borderRadius: 14,
                    textAlign: 'left',
                    padding: '10px 14px',
                    cursor: 'pointer',
                    marginBottom: 6,
                    transition: 'background-color 0.18s ease, color 0.18s ease',
                  }}
                >
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: activeConversation ? 600 : 500,
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
          ) : (
            <div style={{ paddingLeft: 14, paddingRight: 14, fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
              No saved chats yet.
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Approval Card ──

function RiskBadge({ risk }: { risk: string }) {
  return (
    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, letterSpacing: '0.02em', textTransform: 'uppercase', color: '#fff', backgroundColor: RISK_COLORS[risk] ?? RISK_COLORS.low }}>
      {risk}
    </span>
  );
}

function ApprovalCard({ approval, onResolve, resolving }: { approval: ApprovalItem; onResolve: (id: string, action: 'approve' | 'reject') => void; resolving: string | null }) {
  const isResolving = resolving === approval.id;
  const agent = approval.metadata?.agent ?? approval.sessionKey?.split(':').pop() ?? 'agent';

  return (
    <div style={{ backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 14, padding: 16, marginBottom: 12, border: '1px solid rgba(255,255,255,0.08)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <RiskBadge risk={approval.risk} />
        <span style={{ fontSize: 12, color: '#9ca3af' }}>{timeAgo(approval.createdAt)}</span>
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, color: '#f3f4f6', marginBottom: 4, lineHeight: 1.3 }}>{approval.title}</div>
      {approval.toolName && <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 4, fontFamily: 'SF Mono, Menlo, monospace' }}>{approval.toolName}</div>}
      <div style={{ fontSize: 13, color: '#d1d5db', marginBottom: 4 }}>{agent}</div>
      {approval.summary && <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 12, lineHeight: 1.4 }}>{approval.summary.length > 200 ? `${approval.summary.slice(0, 200)}...` : approval.summary}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => onResolve(approval.id, 'approve')} disabled={isResolving} style={{ flex: 1, height: 44, borderRadius: 12, border: 'none', backgroundColor: '#22c55e', color: '#fff', fontSize: 15, fontWeight: 600, cursor: isResolving ? 'default' : 'pointer', opacity: isResolving ? 0.5 : 1, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
          {isResolving ? 'Approving...' : 'Approve'}
        </button>
        <button onClick={() => onResolve(approval.id, 'reject')} disabled={isResolving} style={{ flex: 1, height: 44, borderRadius: 12, border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'transparent', color: '#f87171', fontSize: 15, fontWeight: 600, cursor: isResolving ? 'default' : 'pointer', opacity: isResolving ? 0.5 : 1, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
          Reject
        </button>
      </div>
    </div>
  );
}

// ── Approvals View ──

function ApprovalsView({ approvals, onResolve, resolving, onRefresh }: {
  approvals: ApprovalItem[];
  onResolve: (id: string, action: 'approve' | 'reject') => void;
  resolving: string | null;
  onRefresh: () => void;
}) {
  const pending = approvals.filter((a) => a.status === 'pending' && isGovernanceApproval(a));

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: '#6b7280' }}>
          {pending.length} pending approval{pending.length !== 1 ? 's' : ''}
        </div>
        <button onClick={onRefresh} style={{ width: 36, height: 36, borderRadius: 10, border: '1px solid rgba(255,255,255,0.1)', backgroundColor: 'transparent', color: '#9ca3af', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }} aria-label="Refresh">
          <IconRefresh />
        </button>
      </div>
      {pending.length > 0 ? (
        pending.map((a) => <ApprovalCard key={a.id} approval={a} onResolve={onResolve} resolving={resolving} />)
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 100, color: '#6b7280' }}>
          <IconCheck />
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4, marginTop: 16 }}>All clear</div>
          <div style={{ fontSize: 13 }}>No pending approvals</div>
        </div>
      )}
    </>
  );
}

// ── Chat List View (Anthropic-style) ──

function ChatListView({
  conversations,
  loading,
  onSelect,
  onNewChat,
  onRefresh,
}: {
  conversations: ChatHistoryRecord[];
  loading: boolean;
  onSelect: (tabId: string) => void;
  onNewChat: () => void;
  onRefresh: () => void;
}) {
  function chatTimeAgo(dateStr: string): string {
    const ms = Date.now() - new Date(dateStr).getTime();
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 3_600_000);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks}w ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  }

  if (loading) {
    return (
      <div style={{ paddingTop: 60, textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
        Loading conversations...
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', minHeight: 'calc(100dvh - 80px)' }}>
      {conversations.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 100, color: '#6b7280' }}>
          <IconChat />
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4, marginTop: 16 }}>No conversations yet</div>
          <div style={{ fontSize: 13 }}>Tap + to start a new chat</div>
        </div>
      ) : (
        conversations.map((conv) => (
          <button
            key={conv.tabId}
            onClick={() => onSelect(conv.tabId)}
            style={{
              display: 'flex',
              alignItems: 'center',
              width: '100%',
              padding: '14px 0',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              backgroundColor: 'transparent',
              border: 'none',
              borderBlockEnd: '1px solid rgba(255,255,255,0.06)',
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: 'system-ui, -apple-system, sans-serif',
            }}
          >
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <div style={{ fontSize: 15, fontWeight: 500, color: '#f3f4f6', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {conv.title || 'Untitled'}
              </div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                {chatTimeAgo(conv.updatedAt)}
              </div>
            </div>
            <svg width="16" height="16" viewBox="0 0 256 256" fill="#6b7280" style={{ flexShrink: 0, marginLeft: 8 }}>
              <path d="M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z" />
            </svg>
          </button>
        ))
      )}

      {/* New chat FAB */}
      <button
        onClick={onNewChat}
        style={{
          position: 'fixed',
          bottom: 'max(env(safe-area-inset-bottom, 0px), 24px)',
          right: 24,
          width: 56,
          height: 56,
          borderRadius: 28,
          border: 'none',
          backgroundColor: '#c27436',
          color: '#fff',
          fontSize: 28,
          fontWeight: 300,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
        } as React.CSSProperties}
        aria-label="New chat"
      >
        +
      </button>
    </div>
  );
}

// ── Chat View ──

function ChatView({
  currentTabId,
  onTabIdChange,
  onConversationSaved,
  onBack,
}: {
  currentTabId: string | null;
  onTabIdChange: (tabId: string) => void;
  onConversationSaved: () => void;
  onBack?: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<string | null>(currentTabId);
  const streamAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    activeTabRef.current = currentTabId;
  }, [currentTabId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (currentTabId) {
      window.localStorage.setItem(MOBILE_CHAT_STORAGE_KEY, currentTabId);
      return;
    }

    const storedTabId = window.localStorage.getItem(MOBILE_CHAT_STORAGE_KEY);
    const nextTabId = storedTabId || generateChatTabId();
    window.localStorage.setItem(MOBILE_CHAT_STORAGE_KEY, nextTabId);
    onTabIdChange(nextTabId);
  }, [currentTabId, onTabIdChange]);

  useEffect(() => {
    if (!currentTabId) return;

    activeTabRef.current = currentTabId;
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    setStreaming(false);
    setInput('');
    setMessages([]);
    setHistoryLoading(true);

    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(currentTabId)}`, { cache: 'no-store' });
        if (!res.ok) throw new Error('Failed to load chat history');

        const data = await res.json() as { messages?: unknown };
        if (!cancelled) {
          setMessages(normalizeChatMessages(data.messages));
        }
      } catch {
        if (!cancelled) {
          setMessages([]);
        }
      } finally {
        if (!cancelled) {
          setHistoryLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentTabId]);

  useEffect(() => () => {
    streamAbortRef.current?.abort();
  }, []);

  const saveConversation = useCallback(async (tabId: string, nextMessages: ChatMessage[]) => {
    if (!tabId || nextMessages.length === 0) return;

    try {
      await fetch('/api/v2/chat-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          tabId,
          messages: nextMessages,
          model: MOBILE_CHAT_MODEL,
          title: getConversationTitle(nextMessages),
        }),
      });
      onConversationSaved();
    } catch {
      // non-critical persistence failure
    }
  }, [onConversationSaved]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    const tabId = currentTabId;
    if (!text || streaming || historyLoading || !tabId) return;

    setInput('');

    const userMsg: ChatMessage = { role: 'user', content: text };
    const assistantMsg: ChatMessage = { role: 'assistant', content: '' };
    const requestMessages = [...messages, userMsg];
    let finalMessages = [...requestMessages, assistantMsg];
    setMessages(finalMessages);
    setStreaming(true);

    const controller = new AbortController();
    streamAbortRef.current = controller;

    try {
      const res = await fetch('/api/v2/proxy/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: MOBILE_CHAT_MODEL,
          provider: 'google',
          messages: requestMessages.map((message) => ({ role: message.role, content: message.content })),
          stream: true,
        }),
      });

      if (!res.ok || !res.body) {
        finalMessages = [...requestMessages, { role: 'assistant', content: 'Failed to get a response. Check your API keys.' }];
        if (activeTabRef.current === tabId) {
          setMessages(finalMessages);
        }
        await saveConversation(tabId, finalMessages);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload) as { type?: string; text?: string };
            if (parsed.type === 'content' && parsed.text) {
              fullText += parsed.text;
              finalMessages = [...requestMessages, { role: 'assistant', content: fullText }];
              if (activeTabRef.current === tabId) {
                setMessages(finalMessages);
              }
            }
          } catch { /* skip malformed SSE lines */ }
        }
      }
      if (!fullText.trim()) {
        finalMessages = [...requestMessages, { role: 'assistant', content: 'No response received.' }];
        if (activeTabRef.current === tabId) {
          setMessages(finalMessages);
        }
      }
      await saveConversation(tabId, finalMessages);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      finalMessages = [...requestMessages, { role: 'assistant', content: 'Connection error. Is the server running?' }];
      if (activeTabRef.current === tabId) {
        setMessages(finalMessages);
      }
      await saveConversation(tabId, finalMessages);
    } finally {
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null;
      }
      if (activeTabRef.current === tabId) {
        setStreaming(false);
      }
    }
  }, [currentTabId, historyLoading, input, messages, saveConversation, streaming]);

  const handleNewChat = useCallback(() => {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    setStreaming(false);
    setHistoryLoading(false);
    setInput('');
    setMessages([]);

    const nextTabId = generateChatTabId();
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(MOBILE_CHAT_STORAGE_KEY, nextTabId);
    }
    onTabIdChange(nextTabId);
  }, [onTabIdChange]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 80px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingBottom: 12 }}>
        <div style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.4 }}>
          {historyLoading || !currentTabId ? 'Loading conversation...' : 'Chats are saved automatically.'}
        </div>
        <button
          onClick={handleNewChat}
          disabled={streaming}
          style={{
            height: 36,
            padding: '0 14px',
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.1)',
            backgroundColor: 'rgba(255,255,255,0.04)',
            color: streaming ? '#6b7280' : '#d1d5db',
            fontSize: 13,
            fontWeight: 600,
            cursor: streaming ? 'default' : 'pointer',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          New chat
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', paddingBottom: 16 }}>
        {(historyLoading || !currentTabId) && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 100, color: '#6b7280' }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Loading conversation</div>
            <div style={{ fontSize: 13, textAlign: 'center', padding: '0 32px', lineHeight: 1.5 }}>
              Pulling saved messages from your chat history.
            </div>
          </div>
        )}
        {!historyLoading && currentTabId && messages.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 100, color: '#6b7280' }}>
            <IconChat />
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4, marginTop: 16 }}>Chat with Gemini</div>
            <div style={{ fontSize: 13, textAlign: 'center', padding: '0 32px', lineHeight: 1.5 }}>Ask questions, brainstorm, or get help with your projects.</div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              marginBottom: msg.role === 'user' ? 14 : 20,
              display: 'flex',
              justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            {msg.role === 'user' ? (
              <div
                style={{
                  maxWidth: '82%',
                  padding: '10px 14px',
                  borderRadius: 16,
                  borderBottomRightRadius: 6,
                  backgroundColor: '#2563eb',
                  color: '#fff',
                  fontSize: 14,
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  boxShadow: '0 10px 24px rgba(37,99,235,0.2)',
                }}
              >
                {msg.content}
              </div>
            ) : (
              <div
                style={{
                  width: '100%',
                  paddingTop: 2,
                  paddingRight: 18,
                }}
              >
                {msg.content ? <MobileMarkdown content={msg.content} /> : (streaming && i === messages.length - 1 ? <StreamingDot /> : null)}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Input */}
      <div style={{ display: 'flex', gap: 8, paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 12px)', paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.08)' } as React.CSSProperties}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage(); } }}
          placeholder={historyLoading ? 'Loading chat...' : 'Message Gemini...'}
          disabled={streaming || historyLoading || !currentTabId}
          style={{
            flex: 1,
            height: 44,
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.12)',
            backgroundColor: 'rgba(255,255,255,0.06)',
            color: '#f3f4f6',
            fontSize: 15,
            paddingLeft: 14,
            paddingRight: 14,
            outline: 'none',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        />
        <button
          onClick={() => void sendMessage()}
          disabled={streaming || historyLoading || !currentTabId || !input.trim()}
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            border: 'none',
            backgroundColor: input.trim() && !streaming && !historyLoading && currentTabId ? '#2563eb' : 'rgba(255,255,255,0.06)',
            color: input.trim() && !streaming && !historyLoading && currentTabId ? '#fff' : '#6b7280',
            cursor: input.trim() && !streaming && !historyLoading && currentTabId ? 'pointer' : 'default',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background-color 0.15s ease',
          }}
          aria-label="Send"
        >
          <IconSend />
        </button>
      </div>
    </div>
  );
}

// ── Main Shell ──

export function MobileApprovalsClient({ initialApprovals }: { initialApprovals: ApprovalItem[] }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeView, setActiveView] = useState<MobileView>('approvals');
  const [approvals, setApprovals] = useState<ApprovalItem[]>(initialApprovals);
  const [resolving, setResolving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentTabId, setCurrentTabId] = useState<string | null>(null);
  const [recentConversations, setRecentConversations] = useState<ChatHistoryRecord[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/panel/approvals?status=pending', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json() as { approvals?: ApprovalItem[] };
        setApprovals(data.approvals ?? []);
        setError(null);
      }
    } catch {
      setError('Unable to reach server');
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [refresh]);

  const loadRecentConversations = useCallback(async () => {
    setRecentLoading(true);
    try {
      const res = await fetch('/api/v2/chat-history/list', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load conversations');
      const data = await res.json();
      setRecentConversations(normalizeHistoryList(data));
    } catch {
      setRecentConversations([]);
    } finally {
      setRecentLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return;
    void loadRecentConversations();
  }, [loadRecentConversations, sidebarOpen]);

  const handleResolve = useCallback(async (id: string, action: 'approve' | 'reject') => {
    setResolving(id);
    try {
      const res = await fetch('/api/panel/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id }),
      });
      if (res.ok) {
        setApprovals((prev) => prev.filter((a) => a.id !== id));
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? 'Failed to resolve approval');
      }
    } catch {
      setError('Unable to reach server');
    }
    setResolving(null);
  }, []);

  const handleSelectConversation = useCallback((tabId: string) => {
    setCurrentTabId(tabId);
    setActiveView('chat');
  }, []);

  const governanceCount = approvals.filter((a) => a.status === 'pending' && isGovernanceApproval(a)).length;
  const inConversation = activeView === 'chat' && currentTabId !== null;
  const viewTitle = activeView === 'approvals' ? 'Approvals' : inConversation ? (recentConversations.find((c) => c.tabId === currentTabId)?.title ?? 'Chat') : 'Chats';

  // Load conversations when switching to chat list
  useEffect(() => {
    if (activeView === 'chat' && !currentTabId) {
      void loadRecentConversations();
    }
  }, [activeView, currentTabId, loadRecentConversations]);

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: '#111111', color: '#f3f4f6', fontFamily: 'system-ui, -apple-system, sans-serif', WebkitFontSmoothing: 'antialiased', padding: '0 16px' } as React.CSSProperties}>
      <Sidebar
        open={sidebarOpen}
        activeView={activeView}
        approvalCount={governanceCount}
        currentTabId={currentTabId}
        recentConversations={recentConversations}
        recentLoading={recentLoading}
        onNavigate={setActiveView}
        onSelectConversation={handleSelectConversation}
        onClose={() => setSidebarOpen(false)}
      />

      {/* Header */}
      <div style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), 16px)', paddingBottom: 12, display: 'flex', alignItems: 'center', gap: 12 } as React.CSSProperties}>
        {inConversation ? (
          <button
            onClick={() => setCurrentTabId(null)}
            style={{ width: 44, height: 44, borderRadius: 12, border: '1px solid rgba(255,255,255,0.1)', backgroundColor: 'transparent', color: '#9ca3af', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            aria-label="Back to chats"
          >
            <svg width="20" height="20" viewBox="0 0 256 256" fill="currentColor">
              <path d="M168.49,199.51a12,12,0,0,1-17,17l-80-80a12,12,0,0,1,0-17l80-80a12,12,0,0,1,17,17L97,128Z" />
            </svg>
          </button>
        ) : (
          <button
            onClick={() => setSidebarOpen(true)}
            style={{ width: 44, height: 44, borderRadius: 12, border: '1px solid rgba(255,255,255,0.1)', backgroundColor: 'transparent', color: '#9ca3af', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}
            aria-label="Menu"
          >
            <IconHamburger />
            {governanceCount > 0 && activeView !== 'approvals' && (
              <span style={{ position: 'absolute', top: 6, right: 6, width: 8, height: 8, borderRadius: 4, backgroundColor: '#ef4444' }} />
            )}
          </button>
        )}
        <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{viewTitle}</div>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{ backgroundColor: 'rgba(239,68,68,0.15)', borderRadius: 10, padding: '8px 12px', marginBottom: 12, fontSize: 13, color: '#f87171' }}>
          {error}
        </div>
      )}

      {/* Views */}
      {activeView === 'approvals' && (
        <ApprovalsView approvals={approvals} onResolve={handleResolve} resolving={resolving} onRefresh={() => void refresh()} />
      )}
      {activeView === 'chat' && !currentTabId && (
        <ChatListView
          conversations={recentConversations}
          loading={recentLoading}
          onSelect={(tabId) => setCurrentTabId(tabId)}
          onNewChat={() => {
            const newId = `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            setCurrentTabId(newId);
          }}
          onRefresh={() => void loadRecentConversations()}
        />
      )}
      {activeView === 'chat' && currentTabId && (
        <ChatView
          currentTabId={currentTabId}
          onTabIdChange={setCurrentTabId}
          onConversationSaved={() => {
            void loadRecentConversations();
          }}
          onBack={() => setCurrentTabId(null)}
        />
      )}
    </div>
  );
}
