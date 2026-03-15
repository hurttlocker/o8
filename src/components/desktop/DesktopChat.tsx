'use client';

/**
 * DesktopChat — Right-sidebar chat panel for Dashboard v1.
 *
 * Visually identical to the mobile chat — uses the SAME remodex-* CSS
 * classes from globals.css. Independent component tree: editing this
 * does NOT affect mobile, and vice versa.
 *
 * Differences from mobile:
 *   - No hamburger menu
 *   - Fixed sidebar layout (not full-screen)
 *   - Session picker is a dropdown in the header
 *   - Scroll container is the sidebar div, not the window
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import {
  ArrowUp,
  Brain,
  ChevronDown,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  MobileInboxSnapshot,
  MobileTranscriptEntry,
  MobileTranscriptMedia,
} from '@/lib/mobile/types';

// ── Types ──

type SessionSummary = MobileInboxSnapshot['sessions'][number];

// ── Agent name helper ──

function getAgentName(s: SessionSummary): string {
  if (s.isCurrentSession) return 'Mister';
  const name = s.name || s.sessionKey;
  if (name.includes('codex-owned')) return 'Codex';
  if (name.includes('ace')) return 'Niot';
  if (name.includes('hawk')) return 'Hawk';
  return name;
}

function roleLabel(role: string, agentName?: string): string {
  if (role === 'user') return 'You';
  if (role === 'system') return 'System';
  return agentName ?? 'Assistant';
}

// ── Media helpers ──

function mediaHref(path: string): string {
  return `/api/mobile/media?path=${encodeURIComponent(path)}`;
}

function isImageMedia(item: MobileTranscriptMedia): boolean {
  return item.kind !== 'pdf' && item.kind !== 'file';
}

// ── Memoized Message Bubble ──

interface BubbleProps {
  entry: MobileTranscriptEntry;
  previousEntry: MobileTranscriptEntry | null;
  isLatest: boolean;
  agentName: string;
}

const Bubble = memo(function Bubble({ entry, previousEntry, isLatest, agentName }: BubbleProps) {
  const isUser = entry.role === 'user';
  const hasText = Boolean(entry.text.trim());
  const hasMedia = Boolean(entry.media?.length);
  const speakerChanged = !previousEntry || previousEntry.role !== entry.role;
  const showTimestamp = (() => {
    if (!previousEntry?.timestampLabel || !entry.timestampLabel) return speakerChanged;
    const prev = new Date(`1970-01-01 ${previousEntry.timestampLabel}`).getTime();
    const curr = new Date(`1970-01-01 ${entry.timestampLabel}`).getTime();
    if (Number.isNaN(prev) || Number.isNaN(curr)) return speakerChanged;
    return Math.abs(curr - prev) >= 15 * 60 * 1000;
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
        {hasText ? (
          <div className="remodex-user-bubble">
            <div className="remodex-rich-text">
              {entry.text.split('\n').map((line, i) => (
                <p key={i} className="remodex-rich-paragraph">{line}</p>
              ))}
            </div>
          </div>
        ) : null}
        {hasMedia ? (
          <div className="remodex-media-grid remodex-media-grid-right">
            {entry.media!.map((item) =>
              isImageMedia(item) ? (
                <div key={item.path} className="remodex-media-card remodex-media-card-image">
                  <Image src={mediaHref(item.path)} alt={item.name} width={1200} height={900} unoptimized loading="lazy" />
                </div>
              ) : null
            )}
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
          <span>{roleLabel(entry.role, agentName)}</span>
        </div>
      ) : null}
      {hasText ? (
        <div className="remodex-rich-text">
          {renderMarkdown(entry.text)}
        </div>
      ) : null}
      {hasMedia ? (
        <div className="remodex-media-grid">
          {entry.media!.map((item) =>
            isImageMedia(item) ? (
              <div key={item.path} className="remodex-media-card remodex-media-card-image">
                <Image src={mediaHref(item.path)} alt={item.name} width={1200} height={900} unoptimized loading="lazy" />
              </div>
            ) : null
          )}
        </div>
      ) : null}
    </article>
  );
});

// ── Markdown renderer (matches mobile renderMessageBody) ──

function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <pre key={`code-${i}`} className="remodex-rich-codeblock">
          {lang ? <div className="remodex-rich-codeblock-lang">{lang}</div> : null}
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // Heading
    if (line.startsWith('## ')) {
      elements.push(<h3 key={`h-${i}`} className="remodex-rich-heading">{line.slice(3)}</h3>);
      i++;
      continue;
    }
    if (line.startsWith('# ')) {
      elements.push(<h2 key={`h-${i}`} className="remodex-rich-heading">{line.slice(2)}</h2>);
      i++;
      continue;
    }

    // List item
    if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(
        <div key={`li-${i}`} className="remodex-rich-list-item">
          <span className="remodex-rich-list-bullet">•</span>
          <span>{renderInline(line.slice(2))}</span>
        </div>
      );
      i++;
      continue;
    }

    // Table row (pipe-delimited)
    if (line.includes('|') && line.trim().startsWith('|')) {
      const tableRows: string[] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim().startsWith('|')) {
        if (!lines[i].match(/^\s*\|[\s-|]+\|\s*$/)) { // skip separator rows
          tableRows.push(lines[i]);
        }
        i++;
      }
      if (tableRows.length > 0) {
        elements.push(
          <div key={`table-${i}`} className="remodex-rich-table-wrap">
            <table className="remodex-rich-table">
              <tbody>
                {tableRows.map((row, ri) => (
                  <tr key={ri}>
                    {row.split('|').filter(c => c.trim()).map((cell, ci) => (
                      ri === 0
                        ? <th key={ci}>{renderInline(cell.trim())}</th>
                        : <td key={ci}>{renderInline(cell.trim())}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      continue;
    }

    // Empty line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Regular paragraph
    elements.push(<p key={`p-${i}`} className="remodex-rich-paragraph">{renderInline(line)}</p>);
    i++;
  }

  return elements;
}

// ── Inline formatting (bold, code, links) ──

function renderInline(text: string): React.ReactNode {
  // Split by inline code, bold, and plain text
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} className="remodex-rich-inline-code">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return <span key={i}>{part}</span>;
  });
}

// ── Session Picker Dropdown ──

function SessionPicker({
  sessions,
  selectedKey,
  onSelect,
  open,
  onToggle,
}: {
  sessions: SessionSummary[];
  selectedKey: string;
  onSelect: (key: string) => void;
  open: boolean;
  onToggle: () => void;
}) {
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
        {selected ? getAgentName(selected) : 'Select session'}
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
          <div onClick={onToggle} style={{ position: 'fixed', inset: 0, zIndex: 99 }} />
          <div style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            width: 260,
            background: 'rgba(255, 255, 255, 0.92)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            borderRadius: 12,
            border: '1px solid rgba(0,0,0,0.08)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
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
                  background: s.sessionKey === selectedKey ? 'rgba(37, 99, 235, 0.08)' : 'transparent',
                  border: 'none',
                  borderRadius: 8,
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
                  {getAgentName(s)}
                </span>
                {s.sessionKey === selectedKey ? (
                  <span style={{ color: '#2563eb', fontSize: 12 }}>✓</span>
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
  const [enhancing, setEnhancing] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottomRef = useRef(true);

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
        // Default to the Telegram group session (our live chat) if available
        const telegramGroup = data.sessions.find(s => s.sessionKey.includes('telegram:group'));
        const primary = telegramGroup ?? data.sessions.find(s => s.isCurrentSession) ?? data.sessions[0];
        setSelectedKey(primary.sessionKey);
      }
    } catch { /* silent */ }
  }, [selectedKey]);

  // ── Fetch transcript ──
  const fetchTranscript = useCallback(async (key: string) => {
    if (!key) return;
    try {
      const res = await fetch(`/api/mobile/history?sessionKey=${encodeURIComponent(key)}&limit=50`);
      if (!res.ok) return;
      const data = await res.json();
      setTranscript(data.transcript ?? data.entries ?? []);
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

  // ── Enhance draft ──
  const enhance = useCallback(async () => {
    if (!draft.trim() || enhancing) return;
    setEnhancing(true);
    try {
      const res = await fetch('/api/mobile/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: draft }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.enhanced) setDraft(data.enhanced);
      }
    } catch { /* silent */ }
    finally { setEnhancing(false); }
  }, [draft, enhancing]);

  // ── Init ──
  useEffect(() => { void fetchSessions(); }, [fetchSessions]);

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
    const interval = setInterval(() => void fetchTranscript(selectedKey), 5000);
    return () => clearInterval(interval);
  }, [selectedKey, fetchTranscript]);

  // Scroll tracking
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distFromBottom < 80;
  }, []);

  useEffect(() => { scrollToBottom(); }, [transcript.length, scrollToBottom]);

  const selectedSession = sessions.find(s => s.sessionKey === selectedKey);
  const currentAgentName = selectedSession ? getAgentName(selectedSession) : 'Mister';
  const chatSendDisabled = !selectedKey || sending || !draft.trim();

  return (
    <div className="remodex-desktop-chat" style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: '#f5f7fb',
      borderLeft: '1px solid rgba(0,0,0,0.06)',
      /* Set CSS vars for remodex compose classes */
      ['--remodex-compose-active' as string]: '0',
      ['--remodex-dock-fade-progress' as string]: '0',
      ['--remodex-dock-motion-progress' as string]: '0',
    }}>
      {/* ── Header (matches mobile TopBar) ── */}
      <div style={{
        flexShrink: 0,
        background: 'rgba(255,255,255,0.82)',
        backdropFilter: 'blur(20px) saturate(1.4)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.4)',
        borderBottom: '1px solid rgba(0,0,0,0.06)',
      }}>
        {/* Top row: session name + status */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 16px 6px',
        }}>
          <SessionPicker
            sessions={sessions}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
            open={pickerOpen}
            onToggle={() => setPickerOpen(p => !p)}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {(selectedSession as unknown as Record<string, unknown>)?.context ? (() => {
              const ctx = (selectedSession as unknown as Record<string, unknown>).context as { usedPercent?: number } | undefined;
              const pct = ctx?.usedPercent;
              if (pct == null) return null;
              return (
                <span style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '2px 8px',
                  borderRadius: 6,
                  background: pct > 70 ? 'rgba(239, 68, 68, 0.1)' : 'rgba(0,0,0,0.04)',
                  color: pct > 70 ? '#ef4444' : '#8e8e93',
                }}>
                  {pct}% used
                </span>
              );
            })() : null}
          </div>
        </div>

        {/* Bottom row: runtime info strip */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 16px 10px',
          fontSize: 12,
          color: '#8e8e93',
          overflow: 'hidden',
        }}>
          {(selectedSession as unknown as Record<string, unknown> | undefined)?.runtimeSurface ? (
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 8px',
              borderRadius: 6,
              background: 'rgba(0,0,0,0.04)',
              fontSize: 11,
              fontWeight: 500,
              color: '#5b6475',
              whiteSpace: 'nowrap',
            }}>
              ⎇ {((selectedSession as unknown as Record<string, unknown>)?.runtimeSurface as { branch?: string } | undefined)?.branch ?? 'main'}
            </span>
          ) : null}
          {selectedSession?.name ? (
            <span style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 11,
              color: '#94a3b8',
            }}>
              {selectedSession.name}
            </span>
          ) : null}
        </div>
      </div>

      {/* ── Messages ── */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="remodex-message-stack"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 14px',
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
            No transcript visible yet — waiting for activity.
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

      {/* ── Compose Bar (identical structure to mobile) ── */}
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
                disabled={enhancing}
                onClick={() => void enhance()}
                style={{ color: enhancing ? '#d1d5db' : '#ff9f0a' }}
              >
                <Sparkles size={18} strokeWidth={2} className={enhancing ? 'spin' : undefined} />
              </button>
            ) : null}
            <button
              type="button"
              disabled={chatSendDisabled}
              onClick={() => void send()}
              aria-label={`Send message to ${currentAgentName}`}
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
            >
              {sending ? (
                <Loader2 size={17} className="spin" />
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
