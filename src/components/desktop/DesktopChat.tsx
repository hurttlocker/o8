'use client';

/**
 * DesktopChat — Right-sidebar chat panel for Dashboard v1.
 *
 * Visually identical to the mobile chat — uses the SAME remodex-* CSS
 * classes from globals.css. Independent component tree: editing this
 * does NOT affect mobile, and vice versa.
 *
 * Differences from mobile:
 *   - No hamburger menu (not needed on desktop)
 *   - Fixed sidebar layout (not full-screen)
 *   - Scroll container is the sidebar div, not the window
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import {
  ArrowUp,
  Brain,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  MobileInboxSnapshot,
  MobileTranscriptEntry,
  MobileTranscriptMedia,
} from '@/lib/mobile/types';
import type { ProjectGroup } from '@/components/mobile/types';
import { buildProjectGroups } from '@/components/mobile/utils';
import { CodeBlock } from './CodeBlock';
import { MessageActions } from './MessageActions';
import { ttsEngine } from '@/lib/tts/engine';

// ── Types ──

type SessionSummary = MobileInboxSnapshot['sessions'][number];

// ── Helpers ──

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

function compactLine(text: string | null | undefined, fallback: string, max = 26): string {
  const val = text ?? fallback;
  if (val.length <= max) return val;
  return val.slice(0, max - 1) + '…';
}

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

  // Parse markdown into blocks for point-to-play
  const mdBlocks = useMemo(
    () => hasText ? renderMarkdownBlocks(entry.text) : [],
    [entry.text, hasText],
  );

  const [activeBlock, setActiveBlock] = useState<number | null>(null);
  const playingRef = useRef(false);

  // Subscribe to TTS state — show/clear blue highlight
  useEffect(() => {
    if (entry.role !== 'assistant') return;
    return ttsEngine.subscribe((state) => {
      const isOurs = state.activeMessageId === entry.id;

      if (isOurs && (state.state === 'playing' || state.state === 'loading')) {
        playingRef.current = true;
        // If Play button was clicked (not point-to-play), highlight from top
        setActiveBlock((prev) => prev ?? 0);
      }

      // Clear when playback ends or switches away
      if (playingRef.current && (state.state === 'idle' || state.state === 'error' || (!isOurs && state.activeMessageId !== null))) {
        playingRef.current = false;
        setActiveBlock(null);
      }
    });
  }, [entry.id, entry.role]);

  const handleBlockClick = useCallback((blockIndex: number) => {
    const textFromHere = mdBlocks
      .slice(blockIndex)
      .map(b => b.rawText)
      .join('\n\n');

    if (!textFromHere.trim()) return;

    setActiveBlock(blockIndex);
    void ttsEngine.play(textFromHere, entry.id);
  }, [mdBlocks, entry.id]);

  return (
    <article className="remodex-message-card remodex-message-card-assistant">
      {speakerChanged ? (
        <div className="remodex-message-head">
          <span>{roleLabel(entry.role, agentName)}</span>
        </div>
      ) : null}
      {hasText ? (
        <div className="remodex-rich-text">
          {entry.role === 'assistant' ? (
            mdBlocks.map((block, idx) => (
              <div
                key={idx}
                onClick={() => handleBlockClick(idx)}
                style={{
                  cursor: 'pointer',
                  borderLeft: activeBlock !== null && idx >= activeBlock
                    ? '2px solid #2563eb'
                    : '2px solid transparent',
                  paddingLeft: 8,
                  marginLeft: -10,
                  borderRadius: 2,
                  transition: 'border-color 200ms ease, background 200ms ease',
                  background: activeBlock === idx ? 'rgba(37, 99, 235, 0.04)' : 'transparent',
                }}
                title="Click to play from here"
              >
                {block.element}
              </div>
            ))
          ) : (
            mdBlocks.map(b => b.element)
          )}
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
      {entry.role === 'assistant' && hasText ? (
        <MessageActions messageId={entry.id} messageText={entry.text} />
      ) : null}
    </article>
  );
});

// ── Markdown renderer ──

/** Parsed block with its raw text for TTS point-to-play */
interface RenderedBlock {
  element: React.ReactNode;
  rawText: string;
}

function renderMarkdownBlocks(text: string): RenderedBlock[] {
  const lines = text.split('\n');
  const blocks: RenderedBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      const raw = codeLines.join('\n');
      blocks.push({
        rawText: lang?.toLowerCase() === 'mermaid' ? 'diagram' : raw,
        element: <CodeBlock key={`code-${i}`} code={raw} language={lang || undefined} />,
      });
      continue;
    }

    if (line.startsWith('## ')) {
      const raw = line.slice(3);
      blocks.push({
        rawText: raw,
        element: <h3 key={`h-${i}`} className="remodex-rich-heading">{raw}</h3>,
      });
      i++;
      continue;
    }
    if (line.startsWith('# ')) {
      const raw = line.slice(2);
      blocks.push({
        rawText: raw,
        element: <h2 key={`h-${i}`} className="remodex-rich-heading">{raw}</h2>,
      });
      i++;
      continue;
    }

    if (line.startsWith('- ') || line.startsWith('* ')) {
      const listItems: { text: string; key: number }[] = [];
      while (i < lines.length && (lines[i].startsWith('- ') || lines[i].startsWith('* '))) {
        listItems.push({ text: lines[i].slice(2), key: i });
        i++;
      }
      const raw = listItems.map(item => item.text).join('. ');
      blocks.push({
        rawText: raw,
        element: (
          <ul key={`ul-${listItems[0].key}`} className="remodex-rich-list">
            {listItems.map(item => (
              <li key={item.key}>{renderInline(item.text)}</li>
            ))}
          </ul>
        ),
      });
      continue;
    }

    if (line.includes('|') && line.trim().startsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      if (tableLines.length >= 2) {
        const isSeparator = (l: string) => /^\s*\|[\s:_-|]+\|\s*$/.test(l);
        const parseCells = (l: string) => l.split('|').slice(1, -1).map(c => c.trim());
        const hasSep = tableLines.length >= 2 && isSeparator(tableLines[1]);
        const headerCells = parseCells(tableLines[0]);
        const bodyRows = tableLines.slice(hasSep ? 2 : 1).filter(l => !isSeparator(l));
        const raw = [headerCells.join(', '), ...bodyRows.map(r => parseCells(r).join(', '))].join('. ');

        blocks.push({
          rawText: raw,
          element: (
            <div key={`table-${i}`} style={{
              overflowX: 'auto',
              margin: '12px 0',
              borderRadius: 12,
              border: '1px solid #e5e7eb',
              backgroundColor: '#ffffff',
              boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
            }}>
              <table style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
              }}>
                <thead>
                  <tr>
                    {headerCells.map((cell, ci) => (
                      <th key={ci} style={{
                        textAlign: 'left',
                        padding: '10px 14px',
                        fontSize: '0.8rem',
                        fontWeight: 600,
                        color: '#6b7280',
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        borderBottom: '2px solid #e5e7eb',
                        whiteSpace: 'nowrap',
                      }}>
                        {renderInline(cell)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {bodyRows.map((row, ri) => {
                    const cells = parseCells(row);
                    return (
                      <tr key={ri} style={{
                        backgroundColor: ri % 2 === 0 ? '#ffffff' : '#f9fafb',
                      }}>
                        {cells.map((cell, ci) => (
                          <td key={ci} style={{
                            textAlign: 'left',
                            padding: '10px 14px',
                            fontSize: '0.85rem',
                            color: '#1f2937',
                            borderBottom: '1px solid #f3f4f6',
                          }}>
                            {renderInline(cell)}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ),
        });
      }
      continue;
    }

    if (!line.trim()) { i++; continue; }

    blocks.push({
      rawText: line.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'),
      element: <p key={`p-${i}`} className="remodex-rich-paragraph">{renderInline(line)}</p>,
    });
    i++;
  }

  return blocks;
}

function renderInline(text: string): React.ReactNode {
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

// ── Main Component ──

export function DesktopChat() {
  const [snapshot, setSnapshot] = useState<MobileInboxSnapshot | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [transcript, setTranscript] = useState<MobileTranscriptEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [enhancing, setEnhancing] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const selectedSession = useMemo(
    () => sessions.find(s => s.sessionKey === selectedKey),
    [sessions, selectedKey]
  );

  const projectGroups = useMemo(
    () => snapshot ? buildProjectGroups(snapshot, selectedSession) : [],
    [snapshot, selectedSession]
  );

  // ── Derived header values ──
  const activeTitle = useMemo(() => {
    if (!selectedSession) return 'Select session';
    return compactLine(
      selectedSession.isCurrentSession ? 'Q ↔ Mister live' : selectedSession.name ?? selectedSession.currentTask,
      selectedSession.name ?? 'Current session',
      30,
    );
  }, [selectedSession]);

  const activeSubtitle = useMemo(() => {
    if (!selectedSession) return '';
    const raw = selectedSession as unknown as Record<string, unknown>;
    const surface = raw.runtimeSurface as { repoSlug?: string; branch?: string } | undefined;
    if (surface?.repoSlug) {
      return compactLine(`/${surface.repoSlug}/${surface.branch ?? 'main'}`, selectedSession.sessionKey, 42);
    }
    return compactLine(selectedSession.sessionKey, 'session', 42);
  }, [selectedSession]);

  const headerLabel = useMemo(() => {
    if (!selectedSession) return 'Session';
    if (selectedSession.runtime === 'codex') return 'Codex';
    if (selectedSession.status === 'running') return 'Live';
    return 'Session';
  }, [selectedSession]);

  const connectionDotColor = selectedSession?.status === 'running'
    ? '#34c759'
    : selectedSession?.status === 'reviewing'
      ? '#ff9f0a'
      : '#8e8e93';

  const currentAgentName = selectedSession ? getAgentName(selectedSession) : 'Mister';

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
      setSnapshot(data);
      setSessions(data.sessions);
      if (!selectedKey && data.sessions.length > 0) {
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

  // ── Select session by id (for squad picker) ──
  const handleSessionFocus = useCallback((sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (session) setSelectedKey(session.sessionKey);
  }, [sessions]);

  // ── Init ──
  useEffect(() => { void fetchSessions(); }, [fetchSessions]);

  useEffect(() => {
    if (selectedKey) {
      setLoading(true);
      setTranscript([]);
      void fetchTranscript(selectedKey);
    }
  }, [selectedKey, fetchTranscript]);

  useEffect(() => {
    if (!selectedKey) return;
    const interval = setInterval(() => void fetchTranscript(selectedKey), 5000);
    return () => clearInterval(interval);
  }, [selectedKey, fetchTranscript]);

  // Reset expanded group when picker closes
  useEffect(() => {
    if (!pickerOpen) setExpandedGroup(null);
  }, [pickerOpen]);

  // Close picker on outside click
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerOpen]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distFromBottom < 80;
  }, []);

  useEffect(() => { scrollToBottom(); }, [transcript.length, scrollToBottom]);

  const chatSendDisabled = !selectedKey || sending || !draft.trim();

  return (
    <div className="remodex-desktop-chat" style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: '#f5f7fb',
      borderLeft: '1px solid rgba(0,0,0,0.06)',
      ['--remodex-compose-active' as string]: '0',
      ['--remodex-dock-fade-progress' as string]: '0',
      ['--remodex-dock-motion-progress' as string]: '0',
    }}>
      {/* ── Header ── */}
      <header
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          padding: '14px 16px',
          borderBottom: '1px solid rgba(0,0,0,0.06)',
          background: 'rgba(255,255,255,0.82)',
          backdropFilter: 'blur(20px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(20px) saturate(1.4)',
          flexShrink: 0,
          zIndex: 10,
        }}
      >
        {/* Session selector — Apple-style pill button */}
        <div ref={pickerRef} style={{ minWidth: 0, flex: 1, position: 'relative' }}>
          <button
            type="button"
            onClick={() => setPickerOpen(p => !p)}
            className="desktop-session-pill"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              padding: '8px 12px',
              margin: 0,
              border: '1px solid rgba(0,0,0,0.06)',
              borderRadius: 12,
              background: pickerOpen ? 'rgba(0,0,0,0.04)' : 'rgba(0,0,0,0.02)',
              cursor: 'pointer',
              textAlign: 'left',
              WebkitTapHighlightColor: 'transparent',
              transition: 'background 180ms ease, border-color 180ms ease',
            }}
            onMouseEnter={(e) => { if (!pickerOpen) e.currentTarget.style.background = 'rgba(0,0,0,0.04)'; }}
            onMouseLeave={(e) => { if (!pickerOpen) e.currentTarget.style.background = 'rgba(0,0,0,0.02)'; }}
            aria-label="Switch session"
            aria-expanded={pickerOpen}
          >
            {/* Status dot */}
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                backgroundColor: connectionDotColor,
                flexShrink: 0,
                boxShadow: connectionDotColor === '#34c759' ? '0 0 8px rgba(52, 199, 89, 0.5)' : 'none',
              }}
            />

            {/* Title block */}
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{
                fontSize: 14,
                fontWeight: 600,
                color: '#111827',
                letterSpacing: '-0.01em',
                lineHeight: 1.3,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {activeTitle}
              </div>
              <div style={{
                fontSize: 11.5,
                color: '#8e8e93',
                lineHeight: 1.3,
                marginTop: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {headerLabel} · {activeSubtitle}
              </div>
            </div>

            {/* Chevron */}
            <ChevronDown
              size={15}
              strokeWidth={2}
              style={{
                flexShrink: 0,
                color: '#c7c7cc',
                transition: 'transform 260ms cubic-bezier(0.32, 0.72, 0, 1)',
                transform: pickerOpen ? 'rotate(180deg)' : 'rotate(0deg)',
              }}
            />
          </button>

          {/* Squad picker dropdown — grouped by project (matches mobile exactly) */}
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 8px)',
              left: '-12px',
              right: '-12px',
              zIndex: 100,
              borderRadius: '14px',
              background: 'rgba(255, 255, 255, 0.96)',
              backdropFilter: 'blur(40px) saturate(1.8)',
              WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
              boxShadow: '0 20px 60px rgba(15, 23, 42, 0.18), 0 1px 3px rgba(15, 23, 42, 0.08)',
              padding: '8px',
              maxHeight: '60vh',
              overflowY: 'auto',
              WebkitOverflowScrolling: 'touch',
              opacity: pickerOpen ? 1 : 0,
              transform: pickerOpen ? 'translateY(0) scale(1)' : 'translateY(-8px) scale(0.97)',
              pointerEvents: pickerOpen ? 'auto' : 'none',
              transition: 'opacity 220ms cubic-bezier(0.32, 0.72, 0, 1), transform 220ms cubic-bezier(0.32, 0.72, 0, 1)',
            }}
          >
            {projectGroups.map((group, gi) => {
              const isExpanded = expandedGroup === group.workspace;
              const isSingle = group.sessions.length === 1;
              const containsSelected = group.sessions.some((s) => s.id === selectedSession?.id);
              const dotColor = group.hasRunning
                ? '#34c759'
                : group.bestContextPct >= 75
                  ? '#ff9f0a'
                  : '#8e8e93';

              return (
                <div key={group.workspace}>
                  <button
                    type="button"
                    onClick={() => {
                      if (isSingle) {
                        handleSessionFocus(group.sessions[0].id);
                        setPickerOpen(false);
                      } else {
                        setExpandedGroup(isExpanded ? null : group.workspace);
                      }
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      width: '100%',
                      padding: '10px 12px',
                      border: 'none',
                      borderRadius: '10px',
                      background: containsSelected && !isExpanded
                        ? 'rgba(37, 99, 235, 0.08)'
                        : 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'background 120ms ease',
                      minHeight: '44px',
                    }}
                  >
                    <span style={{
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      backgroundColor: dotColor,
                      flexShrink: 0,
                      boxShadow: group.hasRunning ? `0 0 6px ${dotColor}` : 'none',
                    }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{
                        fontSize: '14px',
                        fontWeight: containsSelected ? 600 : 500,
                        color: containsSelected ? '#2563eb' : '#111827',
                        lineHeight: 1.3,
                      }}>
                        {group.projectName}
                      </div>
                      <div style={{
                        fontSize: '12px',
                        color: '#8e8e93',
                        lineHeight: 1.3,
                        marginTop: '1px',
                      }}>
                        {group.summary}
                        {group.mostRecentTime ? ` · ${group.mostRecentTime}` : ''}
                      </div>
                    </div>
                    {containsSelected && isSingle ? (
                      <span style={{ fontSize: '11px', fontWeight: 600, color: '#2563eb', flexShrink: 0 }}>✓</span>
                    ) : !isSingle ? (
                      <ChevronRight
                        size={14}
                        strokeWidth={2.2}
                        style={{
                          flexShrink: 0,
                          color: '#8e8e93',
                          transition: 'transform 220ms cubic-bezier(0.32, 0.72, 0, 1)',
                          transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                        }}
                      />
                    ) : null}
                  </button>

                  {/* Expanded session list */}
                  {isExpanded && !isSingle ? (
                    <div style={{
                      marginLeft: '18px',
                      borderLeft: '2px solid rgba(37, 99, 235, 0.12)',
                      paddingLeft: '8px',
                      marginTop: '2px',
                      marginBottom: '4px',
                    }}>
                      {group.sessions.map((session) => {
                        const isActive = session.id === selectedSession?.id;
                        const isRunning = session.status === 'running' || session.status === 'reviewing';
                        const sessionPercent = Math.round(session.context?.usedPercent ?? 0);
                        const sDotColor = isRunning ? '#34c759' : sessionPercent >= 75 ? '#ff9f0a' : '#8e8e93';
                        const name = session.name ?? session.sessionKey ?? session.id;
                        const subtitle = session.currentTask
                          ?? session.branch?.replace(/^(feat|fix|batch|chore|refactor)\//, '')
                          ?? session.sessionKey
                          ?? '';

                        return (
                          <button
                            key={session.id}
                            type="button"
                            onClick={() => {
                              handleSessionFocus(session.id);
                              setPickerOpen(false);
                            }}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '10px',
                              width: '100%',
                              padding: '8px 10px',
                              border: 'none',
                              borderRadius: '10px',
                              background: isActive ? 'rgba(37, 99, 235, 0.08)' : 'transparent',
                              cursor: 'pointer',
                              textAlign: 'left',
                              transition: 'background 120ms ease',
                              minHeight: '44px',
                            }}
                          >
                            <span style={{
                              width: '6px',
                              height: '6px',
                              borderRadius: '50%',
                              backgroundColor: sDotColor,
                              flexShrink: 0,
                              boxShadow: isRunning ? `0 0 5px ${sDotColor}` : 'none',
                            }} />
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{
                                fontSize: '13px',
                                fontWeight: isActive ? 600 : 400,
                                color: isActive ? '#2563eb' : '#111827',
                                lineHeight: 1.3,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}>
                                {name}
                              </div>
                              {subtitle ? (
                                <div style={{
                                  fontSize: '11px',
                                  color: '#8e8e93',
                                  lineHeight: 1.3,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                  marginTop: '1px',
                                }}>
                                  {subtitle}
                                </div>
                              ) : null}
                            </div>
                            {isActive ? (
                              <span style={{ fontSize: '11px', fontWeight: 600, color: '#2563eb', flexShrink: 0 }}>✓</span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}

                  {gi < projectGroups.length - 1 ? (
                    <div style={{
                      height: '1px',
                      background: 'rgba(15, 23, 42, 0.06)',
                      margin: '4px 12px',
                    }} />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        {/* Diff pill (right side) */}
        <button
          type="button"
          disabled
          style={{
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            borderRadius: 999,
            border: '1px solid rgba(0,0,0,0.06)',
            background: 'rgba(0,0,0,0.03)',
            color: '#8e8e93',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'default',
          }}
          aria-label="Open diff sheet"
        >
          <span style={{ color: '#22c55e', fontWeight: 600 }}>+0</span>
          <span style={{ color: '#ef4444', fontWeight: 600 }}>-0</span>
          <span style={{ color: '#8e8e93' }}>0 files</span>
          <SlidersHorizontal size={13} strokeWidth={2} />
        </button>
      </header>

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

      {/* ── Compose Bar (matches mobile exactly) ── */}
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

        {/* Runtime bar — context %, branch, status (matches mobile RuntimeBar) */}
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          marginTop: 6,
          background: 'rgba(255, 255, 255, 0.72)',
          backdropFilter: 'blur(20px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(20px) saturate(1.4)',
          borderRadius: 999,
          border: '1px solid rgba(0,0,0,0.04)',
        }}>
          {/* Context pressure */}
          {(() => {
            const pct = Math.round((selectedSession as unknown as Record<string, unknown>)?.context
              ? ((selectedSession as unknown as Record<string, unknown>).context as { usedPercent?: number })?.usedPercent ?? 0
              : 0);
            const tone = pct >= 70 ? '#ef4444' : pct >= 50 ? '#f59e0b' : '#34c759';
            return (
              <>
                <span style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: tone,
                  flexShrink: 0,
                }} />
                <span style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'rgba(17, 24, 39, 0.72)',
                }}>
                  {pct}% used
                </span>
              </>
            );
          })()}

          <span style={{ color: 'rgba(17, 24, 39, 0.24)', fontSize: 12 }}>·</span>

          {/* Branch */}
          <GitBranch size={12} strokeWidth={1.6} style={{ color: 'rgba(17, 24, 39, 0.42)', flexShrink: 0 }} />
          <span style={{
            fontSize: 12,
            fontWeight: 500,
            color: 'rgba(17, 24, 39, 0.52)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {compactLine(selectedSession?.branch ?? 'main', 'main', 18)}
          </span>
        </div>
      </div>
    </div>
  );
}
