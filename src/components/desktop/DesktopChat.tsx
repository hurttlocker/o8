'use client';

/**
 * DesktopChat — Right-sidebar chat panel for Dashboard v1.
 *
 * Visually identical to the mobile chat. Uses the SAME remodex-* CSS classes
 * from globals.css, but is a completely independent component tree.
 * Editing this does NOT affect mobile, and vice versa.
 *
 * Differences from mobile:
 *   - No hamburger menu
 *   - Scroll container is the sidebar div, not the window
 *   - Session picker is a dropdown in the header
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Brain,
  ChevronDown,
  Plus,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import type {
  MobileInboxSnapshot,
  MobileTranscriptEntry,
} from '@/lib/mobile/types';
import { CodeBlock } from '@/components/mobile/CodeBlock';

// ── Types ──

type SessionSummary = MobileInboxSnapshot['sessions'][number];

// ── Message rendering (mirrors mobile renderMessageBody) ──

function renderText(text: string, keyPrefix: string) {
  const blocks = text.split(/(```[\s\S]*?```)/g);

  return (
    <div className="remodex-rich-text">
      {blocks.map((block, i) => {
        if (block.startsWith('```') && block.endsWith('```')) {
          const firstNewline = block.indexOf('\n');
          const lang = firstNewline > 3 ? block.slice(3, firstNewline).trim() : '';
          const code = block.slice(firstNewline + 1, -3).trim();
          return <CodeBlock key={`${keyPrefix}-code-${i}`} code={code} language={lang || undefined} />;
        }

        const paragraphs = block.split('\n\n');
        return paragraphs.map((p, j) => {
          if (!p.trim()) return null;

          // Headings
          const headingMatch = p.match(/^(#{1,3})\s+(.+)$/m);
          if (headingMatch) {
            return (
              <p key={`${keyPrefix}-h-${i}-${j}`} className="remodex-rich-heading" style={{
                fontWeight: 700,
                fontSize: headingMatch[1].length === 1 ? '1.1rem' : headingMatch[1].length === 2 ? '1rem' : '0.92rem',
                margin: '8px 0 4px',
              }}>
                {renderInline(headingMatch[2])}
              </p>
            );
          }

          // List items
          const lines = p.split('\n');
          const isList = lines.every(l => /^[-*•]\s/.test(l.trim()) || !l.trim());
          if (isList && lines.some(l => /^[-*•]\s/.test(l.trim()))) {
            return (
              <ul key={`${keyPrefix}-list-${i}-${j}`} className="remodex-rich-list" style={{
                margin: '4px 0',
                paddingLeft: 18,
                listStyleType: 'disc',
              }}>
                {lines.filter(l => /^[-*•]\s/.test(l.trim())).map((l, k) => (
                  <li key={k} style={{ fontSize: '0.88rem', lineHeight: 1.5, marginBottom: 2 }}>
                    {renderInline(l.replace(/^[-*•]\s+/, ''))}
                  </li>
                ))}
              </ul>
            );
          }

          return (
            <p key={`${keyPrefix}-p-${i}-${j}`} className="remodex-rich-paragraph" style={{ margin: '4px 0', lineHeight: 1.55 }}>
              {renderInline(p.replace(/\n/g, ' '))}
            </p>
          );
        });
      })}
    </div>
  );
}

function renderInline(text: string) {
  // Handle bold + inline code
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={i} style={{
          background: 'rgba(0,0,0,0.06)',
          padding: '1px 5px',
          borderRadius: 4,
          fontSize: '0.86em',
          fontFamily: '"SF Mono", "Fira Code", monospace',
        }}>
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

// ── Message Bubble (memoized, uses exact mobile CSS classes) ──

interface BubbleProps {
  entry: MobileTranscriptEntry;
  previousEntry: MobileTranscriptEntry | null;
  isLatest: boolean;
  agentName: string;
}

const Bubble = memo(function Bubble({ entry, previousEntry, isLatest, agentName }: BubbleProps) {
  const isUser = entry.role === 'user';
  const speakerChanged = !previousEntry || previousEntry.role !== entry.role;
  const showTimestamp = (() => {
    if (!previousEntry?.timestampLabel || !entry.timestampLabel) return speakerChanged;
    const previous = new Date(`1970-01-01 ${previousEntry.timestampLabel}`).getTime();
    const current = new Date(`1970-01-01 ${entry.timestampLabel}`).getTime();
    if (Number.isNaN(previous) || Number.isNaN(current)) return speakerChanged;
    return Math.abs(current - previous) >= 15 * 60 * 1000;
  })();

  // Compaction marker
  if (entry.role === 'system' && entry.text.toLowerCase().includes('compaction')) {
    return (
      <div className="remodex-compaction-card">
        <span className="remodex-compaction-icon" aria-hidden="true">⟳</span>
        <span className="remodex-compaction-label">Context compacted</span>
        {showTimestamp ? <span className="remodex-compaction-time">{entry.timestampLabel ?? ''}</span> : null}
      </div>
    );
  }

  if (isUser) {
    return (
      <div className="remodex-user-turn-wrap">
        {entry.text.trim() ? (
          <div className="remodex-user-bubble">
            {renderText(entry.text, `${entry.id}-user`)}
          </div>
        ) : null}
        {showTimestamp ? <span className="remodex-turn-time">{entry.timestampLabel ?? 'now'}</span> : null}
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
      {entry.text.trim() ? renderText(entry.text, `${entry.id}-assistant`) : null}
    </article>
  );
});

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
          color: '#111827',
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
            color: '#8e8e93',
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
            width: 280,
            background: 'rgba(255, 255, 255, 0.92)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            borderRadius: 14,
            border: '1px solid rgba(0,0,0,0.08)',
            boxShadow: '0 8px 40px rgba(0,0,0,0.12)',
            zIndex: 100,
            padding: 4,
            maxHeight: 360,
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
                  background: s.sessionKey === selectedKey ? 'rgba(37, 99, 235, 0.08)' : 'transparent',
                  border: 'none',
                  borderRadius: 10,
                  color: '#111827',
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
                  <span style={{ color: '#2563eb', fontSize: 12, fontWeight: 600 }}>✓</span>
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
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [transcript, setTranscript] = useState<MobileTranscriptEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottomRef = useRef(true);

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
    } catch { /* silent */ }
  }, [selectedKey]);

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

  const send = useCallback(async () => {
    if (!draft.trim() || !selectedKey || sending) return;
    const text = draft.trim();
    setDraft('');
    setSending(true);

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
        body: JSON.stringify({ sessionKey: selectedKey, action: 'steer', message: text }),
      });
      setTimeout(() => void fetchTranscript(selectedKey), 2000);
    } catch { /* silent */ }
    finally { setSending(false); }
  }, [draft, selectedKey, sending, fetchTranscript, scrollToBottom]);

  // Init
  useEffect(() => { void fetchSessions(); }, [fetchSessions]);

  useEffect(() => {
    if (selectedKey) {
      setLoading(true);
      setTranscript([]);
      void fetchTranscript(selectedKey);
    }
  }, [selectedKey, fetchTranscript]);

  // Poll
  useEffect(() => {
    if (!selectedKey) return;
    const interval = setInterval(() => void fetchTranscript(selectedKey), 5000);
    return () => clearInterval(interval);
  }, [selectedKey, fetchTranscript]);

  // Scroll tracking
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  useEffect(() => { scrollToBottom(); }, [transcript.length, scrollToBottom]);

  const selectedSession = sessions.find(s => s.sessionKey === selectedKey);
  const currentAgentName = selectedSession ? agentName(selectedSession) : 'Mister';
  const chatSendDisabled = !selectedKey || sending || !draft.trim();

  return (
    <div className="remodex-desktop-chat-root" style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'linear-gradient(180deg, #fbfcff 0%, #f5f7fb 100%)',
      borderLeft: '1px solid rgba(0,0,0,0.06)',
    }}>
      {/* ── Header ── */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid rgba(0,0,0,0.06)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
        background: 'rgba(255,255,255,0.82)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
      }}>
        <SessionPicker
          sessions={sessions}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
          open={pickerOpen}
          onToggle={() => setPickerOpen(p => !p)}
          agentName={agentName}
        />
      </div>

      {/* ── Messages ── */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 14px',
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
            <div className="remodex-skeleton-bubble remodex-skeleton-user remodex-skeleton-short" />
          </div>
        ) : transcript.length === 0 ? (
          <div className="remodex-loading-card">
            No transcript turns visible yet — latest activity may have been tool-heavy or compacted.
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

      {/* ── Compose Bar (mirrors mobile exactly) ── */}
      <div style={{
        padding: '10px 14px 14px',
        flexShrink: 0,
      }}>
        <div className="remodex-compose-surface">
          {/* Status pills row */}
          <div className="remodex-compose-status-bar">
            <span className="remodex-compose-chip remodex-compose-pill">
              {selectedSession?.model ?? 'live'}
            </span>
            <span className="remodex-compose-chip remodex-compose-pill remodex-compose-pill-status">
              {selectedSession?.status ?? 'idle'}
            </span>
          </div>

          {/* Textarea */}
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
          />

          {/* Action row */}
          <div className="remodex-compose-row">
            <button
              type="button"
              className="remodex-compose-chip remodex-compose-chip-icon"
              aria-label="Attach"
            >
              <Plus size={16} strokeWidth={2.2} />
            </button>
            <button
              type="button"
              className="remodex-compose-chip remodex-compose-chip-icon"
              aria-label="Refresh"
              onClick={() => void fetchTranscript(selectedKey)}
            >
              <RefreshCw size={16} strokeWidth={2.2} />
            </button>
            <button
              type="button"
              className="remodex-compose-chip remodex-compose-chip-icon"
              aria-label="Memory recall"
              style={{ color: '#2563eb' }}
            >
              <Brain size={17} strokeWidth={2} />
            </button>
            {draft.trim().length >= 3 ? (
              <button
                type="button"
                className="remodex-compose-chip remodex-compose-chip-icon"
                aria-label="Enhance prompt"
                style={{ color: '#ff9f0a' }}
              >
                <Sparkles size={18} strokeWidth={2} />
              </button>
            ) : null}
            <button
              type="button"
              style={{
                marginLeft: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.32rem',
                minWidth: 42,
                minHeight: 42,
                padding: '0 0.82rem',
                borderRadius: 999,
                border: 'none',
                background: chatSendDisabled ? '#d1d5db' : '#ef4444',
                color: chatSendDisabled ? '#9ca3af' : '#ffffff',
                fontSize: '0.84rem',
                fontWeight: 700,
                boxShadow: chatSendDisabled ? 'none' : '0 4px 14px rgba(239, 68, 68, 0.4)',
                cursor: chatSendDisabled ? 'default' : 'pointer',
              }}
              disabled={chatSendDisabled}
              onClick={() => void send()}
              aria-label={`Send message to ${currentAgentName}`}
            >
              {sending ? (
                <RefreshCw size={17} className="spin" />
              ) : (
                <>
                  <ArrowUp size={17} strokeWidth={2.2} />
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
