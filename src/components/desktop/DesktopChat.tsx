'use client';

/**
 * DesktopChat — Right-sidebar chat panel for Dashboard v1.
 *
 * Visually identical to the mobile chat (same remodex-* CSS classes),
 * but a completely independent component tree. Editing this does NOT
 * affect mobile, and vice versa.
 *
 * Differences from mobile:
 *   - No hamburger menu
 *   - Fixed sidebar layout (not full-screen)
 *   - Session picker is a dropdown in the header, not a drawer
 *   - Scroll container is the sidebar div, not the window
 *
 * @see src/components/mobile/ChatView.tsx (visual reference)
 * @see src/components/mobile/ComposeBar.tsx (visual reference)
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowUp,
  Brain,
  ChevronDown,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  MobileInboxSnapshot,
  MobileTranscriptEntry,
} from '@/lib/mobile/types';

// ── Types ──

type SessionSummary = MobileInboxSnapshot['sessions'][number];

// ── Message Bubble (memoized) ──

interface BubbleProps {
  entry: MobileTranscriptEntry;
  previousEntry: MobileTranscriptEntry | null;
  isLatest: boolean;
  agentName: string;
}

const Bubble = memo(function Bubble({ entry, previousEntry, isLatest, agentName }: BubbleProps) {
  const isUser = entry.role === 'user';
  const speakerChanged = !previousEntry || previousEntry.role !== entry.role;

  // Compaction marker
  if (entry.role === 'system' && entry.text.toLowerCase().includes('compaction')) {
    return (
      <div className="remodex-compaction-card">
        <span className="remodex-compaction-icon" aria-hidden="true">⟳</span>
        <span className="remodex-compaction-label">Context compacted</span>
      </div>
    );
  }

  if (isUser) {
    return (
      <div className="remodex-user-turn-wrap">
        {entry.text.trim() ? (
          <div className="remodex-user-bubble">
            <MessageText text={entry.text} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <article className="remodex-message-card remodex-message-card-assistant">
      {speakerChanged ? (
        <div className="remodex-message-head">
          <span>{agentName}</span>
        </div>
      ) : null}
      {entry.text.trim() ? <MessageText text={entry.text} /> : null}
    </article>
  );
});

// ── Simple markdown-ish text renderer ──

function MessageText({ text }: { text: string }) {
  // Split into paragraphs, render code blocks and inline formatting
  const paragraphs = text.split('\n\n');

  return (
    <div className="remodex-rich-text">
      {paragraphs.map((p, i) => {
        // Code block
        if (p.startsWith('```')) {
          const lines = p.split('\n');
          const lang = lines[0].replace('```', '').trim();
          const code = lines.slice(1).filter(l => l !== '```').join('\n');
          return (
            <pre key={i} style={{
              background: 'rgba(0,0,0,0.3)',
              borderRadius: 8,
              padding: '10px 12px',
              fontSize: 12.5,
              lineHeight: 1.5,
              overflowX: 'auto',
              margin: '6px 0',
              fontFamily: '"SF Mono", "Fira Code", monospace',
            }}>
              {lang ? <div style={{ fontSize: 10, color: '#8e8e93', marginBottom: 4, textTransform: 'uppercase' }}>{lang}</div> : null}
              <code>{code}</code>
            </pre>
          );
        }

        // Inline code
        const parts = p.split(/(`[^`]+`)/g);
        return (
          <p key={i} className="remodex-rich-paragraph" style={{ margin: '4px 0', lineHeight: 1.55 }}>
            {parts.map((part, j) => {
              if (part.startsWith('`') && part.endsWith('`')) {
                return (
                  <code key={j} style={{
                    background: 'rgba(255,255,255,0.08)',
                    padding: '1px 5px',
                    borderRadius: 4,
                    fontSize: '0.88em',
                    fontFamily: '"SF Mono", "Fira Code", monospace',
                  }}>
                    {part.slice(1, -1)}
                  </code>
                );
              }
              // Bold
              const boldParts = part.split(/(\*\*[^*]+\*\*)/g);
              return boldParts.map((bp, k) => {
                if (bp.startsWith('**') && bp.endsWith('**')) {
                  return <strong key={`${j}-${k}`}>{bp.slice(2, -2)}</strong>;
                }
                return <span key={`${j}-${k}`}>{bp}</span>;
              });
            })}
          </p>
        );
      })}
    </div>
  );
}

// ── Session Picker ──

interface SessionPickerProps {
  sessions: SessionSummary[];
  selectedKey: string;
  onSelect: (key: string) => void;
  open: boolean;
  onToggle: () => void;
  agentName: (s: SessionSummary) => string;
}

function SessionPicker({ sessions, selectedKey, onSelect, open, onToggle, agentName }: SessionPickerProps) {
  const selected = sessions.find(s => s.sessionKey === selectedKey);

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'none',
          border: 'none',
          color: '#f2f2f7',
          fontSize: 15,
          fontWeight: 600,
          cursor: 'pointer',
          padding: '4px 8px',
          borderRadius: 8,
          letterSpacing: '-0.01em',
        }}
      >
        <span style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: selected?.status === 'running' ? '#34c759' : selected?.status === 'idle' ? '#ff9f0a' : '#636366',
          flexShrink: 0,
        }} />
        {selected ? agentName(selected) : 'Select session'}
        <ChevronDown
          size={14}
          strokeWidth={2}
          style={{
            transform: open ? 'rotate(180deg)' : 'rotate(0)',
            transition: 'transform 0.22s cubic-bezier(0.32, 0.72, 0, 1)',
          }}
        />
      </button>

      {open ? (
        <>
          <div
            onClick={onToggle}
            style={{ position: 'fixed', inset: 0, zIndex: 99 }}
          />
          <div style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            width: 260,
            background: 'rgba(28, 28, 30, 0.95)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.1)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            zIndex: 100,
            padding: 4,
            maxHeight: 320,
            overflowY: 'auto',
          }}>
            {sessions.map(s => (
              <button
                key={s.sessionKey}
                onClick={() => { onSelect(s.sessionKey); onToggle(); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '10px 12px',
                  background: s.sessionKey === selectedKey ? 'rgba(96, 165, 250, 0.12)' : 'transparent',
                  border: 'none',
                  borderRadius: 8,
                  color: '#f2f2f7',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: s.status === 'running' ? '#34c759' : s.status === 'idle' ? '#ff9f0a' : '#636366',
                  flexShrink: 0,
                }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {agentName(s)}
                </span>
                {s.sessionKey === selectedKey ? (
                  <span style={{ color: '#60a5fa', fontSize: 12 }}>✓</span>
                ) : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ── Main Component ──

export function DesktopChat() {
  // ── State ──
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [transcript, setTranscript] = useState<MobileTranscriptEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [streamingText, setStreamingText] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottomRef = useRef(true);

  // ── Helpers ──
  const agentName = useCallback((s: SessionSummary) => {
    if (s.isCurrentSession) return 'Mister';
    const name = s.name || s.sessionKey;
    if (name.includes('codex-owned')) return 'Codex';
    if (name.includes('ace')) return 'Niot';
    if (name.includes('hawk')) return 'Hawk';
    return name;
  }, []);

  const scrollToBottom = useCallback((force = false) => {
    if (!scrollRef.current) return;
    if (!force && !stickToBottomRef.current) return;
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, []);

  // ── Fetch sessions ──
  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/mobile/inbox');
      if (!res.ok) return;
      const data = (await res.json()) as MobileInboxSnapshot;
      setSessions(data.sessions);
      if (!selectedKey && data.sessions.length > 0) {
        const primary = data.sessions.find(s => s.isCurrentSession) ?? data.sessions[0];
        setSelectedKey(primary.sessionKey);
      }
    } catch {
      // silent
    }
  }, [selectedKey]);

  // ── Fetch transcript ──
  const fetchTranscript = useCallback(async (key: string) => {
    if (!key) return;
    try {
      const res = await fetch(`/api/mobile/history?sessionKey=${encodeURIComponent(key)}&limit=50`);
      if (!res.ok) return;
      const data = await res.json();
      setTranscript(data.entries ?? []);
      setLoading(false);
      scrollToBottom(true);
    } catch {
      setLoading(false);
    }
  }, [scrollToBottom]);

  // ── Send message ──
  const send = useCallback(async () => {
    if (!draft.trim() || !selectedKey || sending) return;
    const text = draft.trim();
    setDraft('');
    setSending(true);

    // Optimistic local append
    const optimistic: MobileTranscriptEntry = {
      id: `local-${Date.now()}`,
      role: 'user',
      text,
      timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setTranscript(prev => [...prev, optimistic]);
    scrollToBottom(true);

    try {
      await fetch('/api/mobile/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionKey: selectedKey,
          action: 'steer',
          message: text,
        }),
      });
      // Refresh transcript after a short delay for the response to land
      setTimeout(() => void fetchTranscript(selectedKey), 2000);
    } catch {
      // silent
    } finally {
      setSending(false);
    }
  }, [draft, selectedKey, sending, fetchTranscript, scrollToBottom]);

  // ── Init + polling ──
  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    if (selectedKey) {
      setLoading(true);
      setTranscript([]);
      void fetchTranscript(selectedKey);
    }
  }, [selectedKey, fetchTranscript]);

  // Poll for new messages
  useEffect(() => {
    if (!selectedKey) return;
    const interval = setInterval(() => {
      void fetchTranscript(selectedKey);
    }, 5000);
    return () => clearInterval(interval);
  }, [selectedKey, fetchTranscript]);

  // ── Scroll tracking ──
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distFromBottom < 80;
  }, []);

  // ── Scroll on new messages ──
  useEffect(() => {
    scrollToBottom();
  }, [transcript.length, scrollToBottom]);

  const selectedSession = sessions.find(s => s.sessionKey === selectedKey);
  const currentAgentName = selectedSession ? agentName(selectedSession) : 'Mister';

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: '#000000',
      borderLeft: '1px solid rgba(255,255,255,0.06)',
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 16px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <SessionPicker
          sessions={sessions}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
          open={pickerOpen}
          onToggle={() => setPickerOpen(p => !p)}
          agentName={agentName}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {selectedSession ? (
            <span style={{
              fontSize: 11,
              color: '#8e8e93',
              padding: '2px 8px',
              borderRadius: 6,
              background: 'rgba(255,255,255,0.05)',
            }}>
              {selectedSession.model ?? 'unknown'}
            </span>
          ) : null}
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        {loading ? (
          <div className="remodex-skeleton-stack">
            <div className="remodex-skeleton-bubble remodex-skeleton-assistant" />
            <div className="remodex-skeleton-bubble remodex-skeleton-user" />
            <div className="remodex-skeleton-bubble remodex-skeleton-assistant remodex-skeleton-wide" />
          </div>
        ) : transcript.length === 0 ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 1,
            color: '#5b6475',
            fontSize: 14,
          }}>
            No messages yet
          </div>
        ) : (
          transcript.map((entry, i) => (
            <Bubble
              key={entry.id}
              entry={entry}
              previousEntry={i > 0 ? transcript[i - 1] : null}
              isLatest={i === transcript.length - 1 && entry.role === 'assistant'}
              agentName={currentAgentName}
            />
          ))
        )}
      </div>

      {/* Compose */}
      <div style={{
        padding: '12px 16px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div className="remodex-compose-surface" style={{
          background: 'rgba(28, 28, 30, 0.6)',
          borderRadius: 14,
          border: '1px solid rgba(255,255,255,0.08)',
          padding: 0,
          position: 'relative',
        }}>
          <textarea
            ref={composeRef}
            className="remodex-compose-input"
            rows={2}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && draft.trim()) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={`Message ${currentAgentName}…`}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#f2f2f7',
              fontSize: 14,
              lineHeight: 1.5,
              padding: '12px 14px 8px',
              resize: 'none',
              width: '100%',
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 8px 8px',
          }}>
            <button
              onClick={() => void fetchTranscript(selectedKey)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 36,
                height: 36,
                borderRadius: 999,
                border: 'none',
                background: 'none',
                color: '#8e8e93',
                cursor: 'pointer',
              }}
              aria-label="Refresh"
            >
              <RefreshCw size={15} strokeWidth={2.2} />
            </button>
            <div style={{ flex: 1 }} />
            <button
              onClick={() => void send()}
              disabled={!draft.trim() || sending}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                minWidth: 38,
                minHeight: 38,
                padding: '0 14px',
                borderRadius: 999,
                border: 'none',
                background: !draft.trim() || sending ? '#333' : '#ef4444',
                color: !draft.trim() || sending ? '#666' : '#fff',
                fontSize: 13,
                fontWeight: 700,
                cursor: !draft.trim() || sending ? 'default' : 'pointer',
                boxShadow: !draft.trim() || sending ? 'none' : '0 4px 14px rgba(239, 68, 68, 0.4)',
              }}
              aria-label={`Send message to ${currentAgentName}`}
            >
              {sending ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <>
                  <ArrowUp size={16} strokeWidth={2.2} />
                  <span>Send</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
