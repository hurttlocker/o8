'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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

// ── Constants ──

const RISK_COLORS: Record<string, string> = { high: '#ef4444', medium: '#f59e0b', low: '#22c55e' };
const POLL_INTERVAL = 5_000;
const SIDEBAR_WIDTH = 280;

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

// ── Sidebar ──

function Sidebar({
  open,
  activeView,
  approvalCount,
  onNavigate,
  onClose,
}: {
  open: boolean;
  activeView: MobileView;
  approvalCount: number;
  onNavigate: (view: MobileView) => void;
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

        {/* Nav items */}
        {items.map((item) => {
          const active = activeView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => { onNavigate(item.id); onClose(); }}
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

// ── Chat View ──

function ChatView() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');

    const userMsg: ChatMessage = { role: 'user', content: text };
    const assistantMsg: ChatMessage = { role: 'assistant', content: '' };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreaming(true);

    try {
      const res = await fetch('/api/v2/proxy/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-2.5-flash',
          provider: 'google',
          messages: [...messages, userMsg].map((m) => ({ role: m.role, content: m.content })),
          stream: true,
        }),
      });

      if (!res.ok || !res.body) {
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: 'assistant', content: 'Failed to get a response. Check your API keys.' };
          return next;
        });
        setStreaming(false);
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
              setMessages((prev) => {
                const next = [...prev];
                next[next.length - 1] = { role: 'assistant', content: fullText };
                return next;
              });
            }
          } catch { /* skip malformed SSE lines */ }
        }
      }
    } catch {
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = { role: 'assistant', content: 'Connection error. Is the server running?' };
        return next;
      });
    }
    setStreaming(false);
  }, [input, messages, streaming]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 80px)' }}>
      {/* Messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', paddingBottom: 16 }}>
        {messages.length === 0 && (
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
              marginBottom: 12,
              display: 'flex',
              justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            <div
              style={{
                maxWidth: '85%',
                padding: '10px 14px',
                borderRadius: 14,
                fontSize: 14,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                ...(msg.role === 'user'
                  ? { backgroundColor: '#2563eb', color: '#fff', borderBottomRightRadius: 4 }
                  : { backgroundColor: 'rgba(255,255,255,0.08)', color: '#e5e7eb', borderBottomLeftRadius: 4 }),
              }}
            >
              {msg.content || (streaming && i === messages.length - 1 ? '...' : '')}
            </div>
          </div>
        ))}
      </div>

      {/* Input */}
      <div style={{ display: 'flex', gap: 8, paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 12px)', paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.08)' } as React.CSSProperties}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage(); } }}
          placeholder="Message Gemini..."
          disabled={streaming}
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
          disabled={streaming || !input.trim()}
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            border: 'none',
            backgroundColor: input.trim() && !streaming ? '#2563eb' : 'rgba(255,255,255,0.06)',
            color: input.trim() && !streaming ? '#fff' : '#6b7280',
            cursor: input.trim() && !streaming ? 'pointer' : 'default',
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

  const governanceCount = approvals.filter((a) => a.status === 'pending' && isGovernanceApproval(a)).length;
  const viewTitle = activeView === 'approvals' ? 'Approvals' : 'Chat';

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: '#111111', color: '#f3f4f6', fontFamily: 'system-ui, -apple-system, sans-serif', WebkitFontSmoothing: 'antialiased', padding: '0 16px' } as React.CSSProperties}>
      <Sidebar open={sidebarOpen} activeView={activeView} approvalCount={governanceCount} onNavigate={setActiveView} onClose={() => setSidebarOpen(false)} />

      {/* Header */}
      <div style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), 16px)', paddingBottom: 12, display: 'flex', alignItems: 'center', gap: 12 } as React.CSSProperties}>
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
        <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em', flex: 1 }}>{viewTitle}</div>
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
      {activeView === 'chat' && <ChatView />}
    </div>
  );
}
