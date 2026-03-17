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

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import Image from 'next/image';
import { useDesktopWebSocket } from './hooks/useDesktopWebSocket';
import type { DesktopWsCallbacks } from './hooks/useDesktopWebSocket';
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
  Square,
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
import { DiffModal } from './DiffModal';
import { MessageActions } from './MessageActions';
import { ttsEngine } from '@/lib/tts/engine';

// ── Types ──

type SessionSummary = MobileInboxSnapshot['sessions'][number];

// ── Helpers ──

function getAgentName(s: SessionSummary): string {
  if (s.runtime === 'claude-code') return 'Claude Code';
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
  isNew?: boolean;
  onOpenMermaid?: (code: string) => void;
}

const Bubble = memo(function Bubble({ entry, previousEntry, isLatest, agentName, isNew, onOpenMermaid }: BubbleProps) {
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
      <div className={`remodex-user-turn-wrap${isNew ? ' remodex-turn-new' : ''}`}>
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
        {showTimestamp ? (
          <span className="remodex-turn-time">
            {entry.id.startsWith('local-') ? (
              <span style={{ color: 'var(--t-text-muted)', fontStyle: 'italic' }}>Sending…</span>
            ) : (
              entry.timestampLabel ?? 'now'
            )}
          </span>
        ) : null}
      </div>
    );
  }

  // Parse markdown into blocks for point-to-play
  const mdBlocks = useMemo(
    () => hasText ? renderMarkdownBlocks(entry.text, onOpenMermaid) : [],
    [entry.text, hasText, onOpenMermaid],
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
    <article className={`remodex-message-card remodex-message-card-assistant${isNew ? ' remodex-turn-new' : ''}`}>
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

function renderMarkdownBlocks(text: string, onOpenMermaid?: (code: string) => void): RenderedBlock[] {
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
        element: <CodeBlock key={`code-${i}`} code={raw} language={lang || undefined} onOpenMermaid={onOpenMermaid} />,
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
              border: '1px solid var(--t-divider)',
              backgroundColor: 'var(--t-panel)',
              boxShadow: '0 1px 3px var(--t-divider-subtle)',
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
                        color: 'var(--t-text-secondary)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        borderBottom: '2px solid var(--t-divider)',
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
                        backgroundColor: ri % 2 === 0 ? 'var(--t-panel)' : 'var(--t-bg)',
                      }}>
                        {cells.map((cell, ci) => (
                          <td key={ci} style={{
                            textAlign: 'left',
                            padding: '10px 14px',
                            fontSize: '0.85rem',
                            color: 'var(--t-text)',
                            borderBottom: '1px solid var(--t-divider-subtle)',
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

    // Block-level images: ![alt](url) on its own line
    const blockImgMatch = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (blockImgMatch) {
      blocks.push({
        rawText: blockImgMatch[1] || 'image',
        element: <ChatImage key={`img-${i}`} alt={blockImgMatch[1]} src={blockImgMatch[2]} />,
      });
      i++;
      continue;
    }

    // Bare image file paths on their own line
    const bareImgMatch = line.trim().match(/^(\/[^\s]+\.(png|jpg|jpeg|gif|webp|svg))$/i);
    if (bareImgMatch) {
      blocks.push({
        rawText: bareImgMatch[1].split('/').pop() ?? 'image',
        element: <ChatImage key={`img-${i}`} alt={bareImgMatch[1].split('/').pop() ?? 'image'} src={bareImgMatch[1]} />,
      });
      i++;
      continue;
    }

    // MEDIA: lines
    if (line.trim().startsWith('MEDIA:')) {
      const mediaPath = line.trim().slice(6).trim();
      if (mediaPath) {
        blocks.push({
          rawText: 'image',
          element: <ChatImage key={`media-${i}`} alt="Generated image" src={mediaPath} />,
        });
      }
      i++;
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

function resolveImageSrc(src: string): string {
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) return src;
  return `/api/panel/serve-image?path=${encodeURIComponent(src)}`;
}

function ChatImage({ src, alt }: { src: string; alt: string }) {
  const [lightbox, setLightbox] = React.useState(false);
  const resolved = resolveImageSrc(src);
  return (
    <>
      <img
        src={resolved}
        alt={alt}
        onClick={() => setLightbox(true)}
        style={{
          maxWidth: '100%',
          maxHeight: 360,
          borderRadius: 10,
          marginTop: 8,
          marginBottom: 8,
          cursor: 'zoom-in',
          boxShadow: '0 2px 12px var(--t-divider)',
          border: '1px solid var(--t-divider)',
          display: 'block',
        }}
      />
      {lightbox && ReactDOM.createPortal(
        <div
          onClick={() => setLightbox(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 99999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            cursor: 'zoom-out',
          }}
        >
          <button
            type="button"
            onClick={() => setLightbox(false)}
            style={{
              position: 'absolute',
              top: 16,
              right: 16,
              width: 36,
              height: 36,
              borderRadius: 18,
              border: 'none',
              background: 'rgba(255,255,255,0.15)',
              color: '#ffffff',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 100000,
            }}
          >
            ✕
          </button>
          <img
            src={resolved}
            alt={alt}
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: '92vw',
              maxHeight: '90vh',
              objectFit: 'contain',
              borderRadius: 8,
              boxShadow: '0 8px 40px rgba(0,0,0,0.4)',
              cursor: 'default',
            }}
          />
        </div>,
        document.body
      )}
    </>
  );
}

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(!\[[^\]]*\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
  return parts.map((part, i) => {
    // Images: ![alt](url)
    const imgMatch = part.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMatch) {
      return <ChatImage key={i} alt={imgMatch[1]} src={imgMatch[2]} />;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} className="remodex-rich-inline-code">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    // Links: [text](url)
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return (
        <a key={i} href={linkMatch[2]} target="_blank" rel="noopener noreferrer"
          style={{ color: '#2563eb', textDecoration: 'none', borderBottom: '1px solid rgba(37,99,235,0.3)' }}>
          {linkMatch[1]}
        </a>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

// ── Main Component ──

export function DesktopChat({ externalSessionKey, onOpenDiff, onOpenMermaid, onWsStatusChange }: { externalSessionKey?: string; onOpenDiff?: () => void; onOpenMermaid?: (code: string) => void; onWsStatusChange?: (status: 'connected' | 'connecting' | 'reconnecting' | 'disconnected') => void } = {}) {
  const [snapshot, setSnapshot] = useState<MobileInboxSnapshot | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [transcript, setTranscript] = useState<MobileTranscriptEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [composeHeight, setComposeHeight] = useState(60);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffStats, setDiffStats] = useState({ additions: 0, deletions: 0, files: 0 });
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<{ name: string; mimeType: string; content: string; preview?: string }[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  // wsConnected is derived from the WS hook below

  const scrollRef = useRef<HTMLDivElement>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const claudeSessionIdRef = useRef<string | undefined>(undefined);
  const codexThreadIdRef = useRef<string | undefined>(undefined);

  const selectedSession = useMemo(
    () => sessions.find(s => s.sessionKey === selectedKey),
    [sessions, selectedKey]
  );

  const streamingTextRef = useRef('');

  // ── WebSocket — real-time updates ──
  const wsCallbacks = useMemo<DesktopWsCallbacks>(() => ({
    onChatDelta: (text: string) => {
      streamingTextRef.current = text;
      setStreamingText(text);
      // Auto-scroll on streaming
      if (stickToBottomRef.current && scrollRef.current) {
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
        });
      }
    },
    onChatDone: (text: string) => {
      streamingTextRef.current = '';
      setStreamingText('');
      setSending(false);
      // Inject final message — poll and history push will reconcile
      if (text) {
        setTranscript(prev => {
          // Dedup: check if this text already exists (from WS history push or prior done)
          const lastFew = prev.slice(-3);
          if (lastFew.some(e => e.role === 'assistant' && e.text === text)) return prev;
          return [...prev, {
            id: `ws:done:${Date.now()}`,
            role: 'assistant' as const,
            text,
            timestampLabel: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
          }];
        });
      }
    },
    onChatError: () => {
      streamingTextRef.current = '';
      setStreamingText('');
      setSending(false);
    },
    onInboxUpdate: (data: Record<string, unknown>) => {
      const inbox = data as unknown as MobileInboxSnapshot;
      if (inbox?.sessions) {
        setSnapshot(inbox);
        setSessions(inbox.sessions);
      }
    },
    onHistoryUpdate: (sessionKey: string, entries: Array<Record<string, unknown>>) => {
      if (sessionKey === selectedKey) {
        const newEntries = entries as unknown as MobileTranscriptEntry[];
        setTranscript(prev => {
          const existingIds = new Set(prev.map(e => e.id));
          // Also dedup by text against ws:done entries
          const existingTexts = new Set(prev.filter(e => e.id.startsWith('ws:')).map(e => e.text));
          const genuinelyNew = newEntries.filter(e =>
            !existingIds.has(e.id) && !(e.role === 'assistant' && existingTexts.has(e.text))
          );
          if (genuinelyNew.length === 0) return prev;
          // Replace ws:done entries with server versions (better IDs)
          const cleaned = prev.filter(p =>
            !p.id.startsWith('ws:') || !genuinelyNew.some(n => n.role === 'assistant' && n.text === p.text)
          );
          return [...cleaned, ...genuinelyNew];
        });
      }
    },
    onReviewUpdate: (data: Record<string, unknown>) => {
      const d = data as { additions?: number; deletions?: number; files?: number };
      if (typeof d.additions === 'number') {
        setDiffStats({ additions: d.additions, deletions: d.deletions ?? 0, files: d.files ?? 0 });
      }
    },
  }), [selectedKey]);

  const { isConnected: wsConnected, connectionState } = useDesktopWebSocket(selectedKey || undefined, wsCallbacks);

  // Report WS status to parent
  useEffect(() => { onWsStatusChange?.(connectionState); }, [connectionState, onWsStatusChange]);

  const isClaudeCode = selectedSession?.runtime === 'claude-code';
  const isCodexLocal = selectedSession?.runtime === 'codex' && selectedSession?.runtimeSurface?.ownership === 'discovered';
  const isLocalAgent = isClaudeCode || isCodexLocal;

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
    if (selectedSession.runtime === 'claude-code') return 'Claude Code';
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
      setSnapshot(prev => JSON.stringify(prev) === JSON.stringify(data) ? prev : data);
      setSessions(prev => JSON.stringify(prev) === JSON.stringify(data.sessions) ? prev : data.sessions);
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
      // Route to Claude Code transcript API for claude-code sessions
      const isCC = key.startsWith('claude-code:');
      const url = isCC
        ? `/api/claude-code/transcript?sessionKey=${encodeURIComponent(key)}&limit=50`
        : `/api/mobile/history?sessionKey=${encodeURIComponent(key)}&limit=50`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const serverEntries: MobileTranscriptEntry[] = data.transcript ?? data.entries ?? [];

      // Append-only merge: never replace the full transcript (prevents old messages
      // from re-appearing after compaction). Only genuinely new entries get appended.
      let didChange = false;
      setTranscript(prev => {
        const optimistic = prev.filter(m => m.id.startsWith('local-'));
        let realPrev = prev.filter(m => !m.id.startsWith('local-'));

        // First load — accept full transcript
        if (realPrev.length === 0) {
          didChange = serverEntries.length > 0;
          return optimistic.length > 0 ? [...serverEntries, ...optimistic] : serverEntries;
        }

        // Find where our last known message sits in the server response
        const lastRealId = realPrev[realPrev.length - 1]?.id;
        const serverIdx = serverEntries.findIndex(e => e.id === lastRealId);

        let newFromServer: MobileTranscriptEntry[] = [];
        if (serverIdx >= 0) {
          // Found our last entry — only take entries after it
          newFromServer = serverEntries.slice(serverIdx + 1);
        } else {
          // Last entry not found (compaction happened) — only add entries
          // whose IDs we haven't seen (don't replace, don't reorder)
          const existingIds = new Set(realPrev.map(e => e.id));
          newFromServer = serverEntries.filter(e => !existingIds.has(e.id));
          // Only add entries that appear AFTER the last timestamp we know about
          // (prevents old messages from appearing at bottom)
          if (newFromServer.length > 0 && realPrev.length > 0) {
            const lastIdx = serverEntries.findIndex(e => e.id === newFromServer[0]?.id);
            const lastKnownIdx = Math.max(...realPrev.map(e => serverEntries.findIndex(se => se.id === e.id)).filter(i => i >= 0));
            if (lastKnownIdx >= 0) {
              newFromServer = newFromServer.filter(e => {
                const idx = serverEntries.indexOf(e);
                return idx > lastKnownIdx;
              });
            }
          }
        }

        // Clear confirmed optimistic + WS-injected messages that server now has
        const serverTexts = new Set(
          [...realPrev, ...newFromServer].filter(e => !e.id.startsWith('local-') && !e.id.startsWith('ws:')).map(e => e.text)
        );
        // WS-injected done messages get replaced by server versions
        const wsInjected = realPrev.filter(e => e.id.startsWith('ws:'));
        if (wsInjected.length > 0 && newFromServer.length > 0) {
          // Remove WS entries whose text matches a server entry
          const wsTexts = new Set(wsInjected.map(e => e.text));
          const serverHasWs = newFromServer.some(e => wsTexts.has(e.text));
          if (serverHasWs) {
            realPrev = realPrev.filter(e => !e.id.startsWith('ws:') || !serverTexts.has(e.text));
          }
        }
        const pendingOptimistic = optimistic.filter(m => !serverTexts.has(m.text));

        if (newFromServer.length === 0 && pendingOptimistic.length === optimistic.length) {
          return prev; // nothing changed
        }

        didChange = newFromServer.length > 0;
        const merged = [...realPrev, ...newFromServer];
        return pendingOptimistic.length > 0 ? [...merged, ...pendingOptimistic] : merged;
      });
      setLoading(false);
      // Only scroll if user is already at bottom — never force-yank upward
      if (didChange && stickToBottomRef.current) {
        scrollToBottom();
      }
    } catch {
      setLoading(false);
    }
  }, [scrollToBottom]);

  // ── File handling ──
  const processFiles = useCallback((files: FileList | File[]) => {
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        const preview = file.type.startsWith('image/')
          ? URL.createObjectURL(file)
          : undefined;
        setPendingFiles(prev => [...prev, {
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          content: base64,
          preview,
        }]);
      };
      reader.readAsDataURL(file);
    });
  }, []);

  const removePendingFile = useCallback((idx: number) => {
    setPendingFiles(prev => {
      const f = prev[idx];
      if (f?.preview) URL.revokeObjectURL(f.preview);
      return prev.filter((_, i) => i !== idx);
    });
  }, []);

  // ── Drag and drop ──
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  }, [processFiles]);

  // ── Paste images from clipboard ──
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          const file = items[i].getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        processFiles(files);
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [processFiles]);

  // ── Send sound ──
  const playSendSound = useCallback(() => {
    try {
      const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(1800, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.04);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.06);
    } catch { /* silent — no audio context available */ }
  }, []);

  // ── Send message ──
  const sendToClaudeCode = useCallback(async (text: string) => {
    const session = sessions.find(s => s.sessionKey === selectedKey);
    const cwd = session?.workspace || undefined;

    // Create a streaming assistant entry
    const assistantId = `claude-${Date.now()}`;
    const assistantEntry: MobileTranscriptEntry = {
      id: assistantId,
      role: 'assistant',
      text: '',
      timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setTranscript(prev => [...prev, assistantEntry]);
    setAgentRunning(true);

    try {
      const res = await fetch('/api/claude-code/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          cwd,
          sessionId: claudeSessionIdRef.current,
        }),
      });

      if (!res.ok || !res.body) {
        setTranscript(prev => prev.map(e =>
          e.id === assistantId ? { ...e, text: `Error: ${res.statusText}` } : e
        ));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6)) as {
              type: string;
              text?: string;
              name?: string;
              sessionId?: string;
              exitCode?: number;
            };

            if (event.type === 'delta' && event.text) {
              accumulated += event.text;
              setTranscript(prev => prev.map(e =>
                e.id === assistantId ? { ...e, text: accumulated } : e
              ));
              scrollToBottom(false);
            }

            if (event.type === 'tool' && event.name) {
              // Show tool usage inline
              const toolLine = `\n🔧 *${event.name}*\n`;
              accumulated += toolLine;
              setTranscript(prev => prev.map(e =>
                e.id === assistantId ? { ...e, text: accumulated } : e
              ));
            }

            if (event.type === 'done' || event.type === 'close') {
              if (event.sessionId) {
                claudeSessionIdRef.current = event.sessionId;
              }
              // Use the final text if close provided it and we have nothing
              if (event.type === 'close' && event.text && !accumulated) {
                accumulated = event.text;
                setTranscript(prev => prev.map(e =>
                  e.id === assistantId ? { ...e, text: accumulated } : e
                ));
              }
            }

            if (event.type === 'error' && event.text) {
              accumulated += `\n⚠️ ${event.text}`;
              setTranscript(prev => prev.map(e =>
                e.id === assistantId ? { ...e, text: accumulated } : e
              ));
            }
          } catch { /* skip malformed SSE lines */ }
        }
      }
    } catch (err) {
      setTranscript(prev => prev.map(e =>
        e.id === assistantId ? { ...e, text: `Error: ${err instanceof Error ? err.message : 'unknown'}` } : e
      ));
    } finally {
      setAgentRunning(false);
    }
  }, [sessions, selectedKey, scrollToBottom]);

  const sendToCodex = useCallback(async (text: string) => {
    const session = sessions.find(s => s.sessionKey === selectedKey);
    const cwd = session?.workspace || undefined;

    const assistantId = `codex-${Date.now()}`;
    const assistantEntry: MobileTranscriptEntry = {
      id: assistantId,
      role: 'assistant',
      text: '',
      timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setTranscript(prev => [...prev, assistantEntry]);
    setAgentRunning(true);

    try {
      const res = await fetch('/api/codex/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          cwd,
          threadId: codexThreadIdRef.current,
        }),
      });

      if (!res.ok || !res.body) {
        setTranscript(prev => prev.map(e =>
          e.id === assistantId ? { ...e, text: `Error: ${res.statusText}` } : e
        ));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6)) as {
              type: string;
              text?: string;
              name?: string;
              threadId?: string;
            };

            if (event.type === 'session' && event.threadId) {
              codexThreadIdRef.current = event.threadId;
            }

            if (event.type === 'delta' && event.text) {
              accumulated += event.text;
              setTranscript(prev => prev.map(e =>
                e.id === assistantId ? { ...e, text: accumulated } : e
              ));
              scrollToBottom(false);
            }

            if (event.type === 'tool' && event.name) {
              const toolLine = `\n🔧 *${event.name}*\n`;
              accumulated += toolLine;
              setTranscript(prev => prev.map(e =>
                e.id === assistantId ? { ...e, text: accumulated } : e
              ));
            }

            if ((event.type === 'done' || event.type === 'close') && event.threadId) {
              codexThreadIdRef.current = event.threadId;
            }

            if (event.type === 'error' && event.text) {
              accumulated += `\n⚠️ ${event.text}`;
              setTranscript(prev => prev.map(e =>
                e.id === assistantId ? { ...e, text: accumulated } : e
              ));
            }
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      setTranscript(prev => prev.map(e =>
        e.id === assistantId ? { ...e, text: `Error: ${err instanceof Error ? err.message : 'unknown'}` } : e
      ));
    } finally {
      setAgentRunning(false);
    }
  }, [sessions, selectedKey, scrollToBottom]);

  const send = useCallback(async () => {
    if ((!draft.trim() && pendingFiles.length === 0) || !selectedKey || sending) return;
    const text = draft.trim();
    const files = [...pendingFiles];
    setDraft('');
    setPendingFiles([]);
    setSending(true);
    playSendSound();

    const optimisticText = files.length > 0
      ? `${text}${text ? '\n' : ''}📎 ${files.map(f => f.name).join(', ')}`
      : text;

    const optimistic: MobileTranscriptEntry = {
      id: `local-${Date.now()}`,
      role: 'user',
      text: optimisticText,
      timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setTranscript(prev => [...prev, optimistic]);
    scrollToBottom(true);

    try {
      // Route to local agent CLIs based on runtime
      if (isClaudeCode) {
        await sendToClaudeCode(text);
      } else if (isCodexLocal) {
        await sendToCodex(text);
      } else {
        const payload: Record<string, unknown> = {
          sessionKey: selectedKey,
          action: 'steer',
          message: text || (files.length > 0 ? `[${files.map(f => f.name).join(', ')}]` : ''),
        };
        if (files.length > 0) {
          payload.attachments = files.map(f => ({
            mimeType: f.mimeType,
            fileName: f.name,
            content: f.content,
          }));
        }
        // Fire and don't wait — optimistic UI already shows the message
        fetch('/api/mobile/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {});
      }
    } catch { /* silent */ }
    finally {
      // Revoke any preview URLs
      files.forEach(f => { if (f.preview) URL.revokeObjectURL(f.preview); });
      setSending(false);
    }
  }, [draft, pendingFiles, selectedKey, sending, isClaudeCode, isCodexLocal, sendToClaudeCode, sendToCodex, fetchTranscript, scrollToBottom, playSendSound]);

  // ── Stop / Abort run ──
  const stopRun = useCallback(async () => {
    if (!selectedKey || stopping) return;
    setStopping(true);
    try {
      await fetch('/api/mobile/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey: selectedKey, action: 'stop' }),
      });
      // Single poll after stop — WS will push the rest
      setTimeout(() => void fetchTranscript(selectedKey), 1000);
    } catch { /* silent */ }
    finally {
      setStopping(false);
      setAgentRunning(false);
    }
  }, [selectedKey, stopping, fetchTranscript]);

  // ── Track agent running state ──
  // Agent is "running" after user sends until an assistant message arrives
  useEffect(() => {
    if (transcript.length === 0) { setAgentRunning(false); return; }
    const last = transcript[transcript.length - 1];
    // If last message is user (or local optimistic) → agent is generating
    if (last.role === 'user' || last.id.startsWith('local-')) {
      setAgentRunning(true);
      // No auto-scroll — user controls position
    } else {
      setAgentRunning(false);
    }
  }, [transcript, scrollToBottom]);

  // ── Diff stats (poll every 30s) ──
  useEffect(() => {
    async function fetchDiffStats() {
      try {
        const res = await fetch('/api/review/workspace');
        if (!res.ok) return;
        const data = await res.json();
        const files = data.changedFiles ?? [];
        setDiffStats({
          additions: files.reduce((s: number, f: { additions?: number }) => s + (f.additions ?? 0), 0),
          deletions: files.reduce((s: number, f: { deletions?: number }) => s + (f.deletions ?? 0), 0),
          files: files.length,
        });
      } catch { /* silent */ }
    }
    void fetchDiffStats();
    const id = setInterval(fetchDiffStats, 30_000);
    return () => clearInterval(id);
  }, []);

  // ── External session key (from Agent Panel click) ──
  useEffect(() => {
    if (externalSessionKey && externalSessionKey !== selectedKey) {
      setSelectedKey(externalSessionKey);
    }
  }, [externalSessionKey]);

  // ── Enhance draft ──
  const enhance = useCallback(async () => {
    if (!draft.trim() || enhancing) return;
    setEnhancing(true);
    try {
      const res = await fetch('/api/mobile/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: draft }),
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
    if (session) {
      setSelectedKey(session.sessionKey);
      // Reset session refs when switching
      if (session.runtime !== 'claude-code') claudeSessionIdRef.current = undefined;
      if (session.runtime !== 'codex') codexThreadIdRef.current = undefined;
    }
  }, [sessions]);

  // ── Init ──
  useEffect(() => { void fetchSessions(); }, [fetchSessions]);

  useEffect(() => {
    if (selectedKey) {
      setLoading(true);
      setTranscript([]);
      seenIdsRef.current.clear();
      void fetchTranscript(selectedKey);
    }
  }, [selectedKey, fetchTranscript]);

  // Safety-net poll: 30s when WS connected, 5s when disconnected
  useEffect(() => {
    if (!selectedKey) return;
    const ms = wsConnected ? 30_000 : 5_000;
    const interval = setInterval(() => void fetchTranscript(selectedKey), ms);
    return () => clearInterval(interval);
  }, [selectedKey, fetchTranscript, wsConnected]);

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

  const [showScrollPill, setShowScrollPill] = useState(false);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distFromBottom < 80;
    setShowScrollPill(distFromBottom > 200);
  }, []);

  // Auto-scroll disabled — user controls position via "new messages" button.
  // Only scroll on initial session load (handled by fetchTranscript).
  // useEffect(() => { scrollToBottom(); }, [transcript.length, scrollToBottom]);

  const chatSendDisabled = !selectedKey || sending || !draft.trim();

  return (
    <div
      className="remodex-desktop-chat"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--t-bg)',
        borderLeft: '1px solid var(--t-divider)',
        position: 'relative',
        outline: dragOver ? '2px solid #3b82f6' : 'none',
        outlineOffset: -2,
      ['--remodex-compose-active' as string]: '0',
      ['--remodex-dock-fade-progress' as string]: '0',
      ['--remodex-dock-motion-progress' as string]: '0',
    }}>
      {/* Drag overlay */}
      {dragOver && (
        <div style={{
          position: 'absolute',
          inset: 0,
          zIndex: 999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(59, 130, 246, 0.08)',
          backdropFilter: 'blur(4px)',
          pointerEvents: 'none',
        }}>
          <div style={{
            paddingTop: 16,
            paddingRight: 32,
            paddingBottom: 16,
            paddingLeft: 32,
            borderRadius: 16,
            background: 'var(--t-panel-translucent)',
            border: '2px dashed #3b82f6',
            fontSize: 15,
            fontWeight: 600,
            color: '#3b82f6',
          }}>
            Drop files here
          </div>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.pdf,.txt,.md,.json,.csv,.tsx,.ts,.js,.py"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files) processFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {/* ── Header ── */}
      <header
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          padding: '14px 16px',
          borderBottom: '1px solid var(--t-divider)',
          background: 'var(--t-panel-translucent)',
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
              border: '1px solid var(--t-divider)',
              borderRadius: 12,
              background: pickerOpen ? 'var(--t-divider-subtle)' : 'var(--t-hover)',
              cursor: 'pointer',
              textAlign: 'left',
              WebkitTapHighlightColor: 'transparent',
              transition: 'background 180ms ease, border-color 180ms ease',
            }}
            onMouseEnter={(e) => { if (!pickerOpen) e.currentTarget.style.background = 'var(--t-divider-subtle)'; }}
            onMouseLeave={(e) => { if (!pickerOpen) e.currentTarget.style.background = 'var(--t-hover)'; }}
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
                color: 'var(--t-text)',
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
                color: 'var(--t-text-muted)',
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
                color: 'var(--t-text-faint)',
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
              background: 'var(--t-panel)',
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
                        color: containsSelected ? '#2563eb' : 'var(--t-text)',
                        lineHeight: 1.3,
                      }}>
                        {group.projectName}
                      </div>
                      <div style={{
                        fontSize: '12px',
                        color: 'var(--t-text-muted)',
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
                          color: 'var(--t-text-muted)',
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
                        const rawName = session.name ?? session.sessionKey ?? session.id;
                        const runtimeTag = session.runtime === 'claude-code' ? ' · Claude Code'
                          : session.runtime === 'codex' ? ' · Codex'
                          : '';
                        const name = rawName + runtimeTag;
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
                                color: isActive ? '#2563eb' : 'var(--t-text)',
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
                                  color: 'var(--t-text-muted)',
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
                      background: 'var(--t-divider)',
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
          onClick={() => onOpenDiff ? onOpenDiff() : setDiffOpen(true)}
          style={{
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            paddingTop: 6,
            paddingRight: 12,
            paddingBottom: 6,
            paddingLeft: 12,
            borderRadius: 999,
            border: diffStats.files > 0 ? '1px solid rgba(37, 99, 235, 0.12)' : '1px solid var(--t-divider)',
            background: diffStats.files > 0 ? 'rgba(37, 99, 235, 0.04)' : 'var(--t-hover)',
            color: 'var(--t-text-muted)',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'all 150ms ease',
          }}
          aria-label="Open diff sheet"
        >
          <span style={{ color: '#22c55e', fontWeight: 600 }}>+{diffStats.additions}</span>
          <span style={{ color: '#ef4444', fontWeight: 600 }}>-{diffStats.deletions}</span>
          <span style={{ color: 'var(--t-text-muted)' }}>{diffStats.files} file{diffStats.files !== 1 ? 's' : ''}</span>
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
          transcript.map((entry, i) => {
            const isNew = !seenIdsRef.current.has(entry.id);
            if (!isNew) { /* already seen */ } else {
              // Mark as seen after first render via microtask
              queueMicrotask(() => seenIdsRef.current.add(entry.id));
            }
            return (
              <Bubble
                key={entry.id}
                entry={entry}
                previousEntry={i > 0 ? transcript[i - 1] : null}
                isLatest={i === transcript.length - 1 && entry.role === 'assistant'}
                agentName={currentAgentName}
                isNew={isNew}
                onOpenMermaid={onOpenMermaid}
              />
            );
          })
        )}

        {/* ── Streaming Text (real-time from WS) ── */}
        {streamingText && (
          <div style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            paddingTop: 8,
            paddingRight: 16,
            paddingBottom: 4,
            paddingLeft: 16,
          }}>
            <div style={{
              maxWidth: '85%',
              paddingTop: 10,
              paddingRight: 16,
              paddingBottom: 10,
              paddingLeft: 16,
              borderRadius: 18,
              background: 'var(--t-panel-translucent)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
              border: '1px solid var(--t-divider-subtle)',
              fontSize: 14,
              lineHeight: 1.5,
              color: 'var(--t-text)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {streamingText}
              <span style={{
                display: 'inline-block',
                width: 6, height: 14,
                background: 'var(--t-text)',
                opacity: 0.4,
                marginLeft: 2,
                animation: 'blink 1s step-end infinite',
                verticalAlign: 'text-bottom',
              }} />
            </div>
          </div>
        )}

        {/* ── Typing Indicator ── */}
        {agentRunning && !streamingText && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            paddingTop: 8,
            paddingRight: 16,
            paddingBottom: 12,
            paddingLeft: 16,
          }}>
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              paddingTop: 10,
              paddingRight: 16,
              paddingBottom: 10,
              paddingLeft: 16,
              borderRadius: 18,
              background: 'var(--t-panel-translucent)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
              border: '1px solid var(--t-divider-subtle)',
            }}>
              <span className="remodex-typing-dot" style={{ animationDelay: '0ms' }} />
              <span className="remodex-typing-dot" style={{ animationDelay: '150ms' }} />
              <span className="remodex-typing-dot" style={{ animationDelay: '300ms' }} />
              <span style={{
                fontSize: 11,
                color: 'var(--t-text-muted)',
                marginLeft: 6,
                fontWeight: 500,
              }}>
                {currentAgentName || 'Agent'} is thinking…
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── Resize Handle ── */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          const startY = e.clientY;
          const startH = composeHeight;
          const onMove = (ev: MouseEvent) => {
            const delta = startY - ev.clientY;
            setComposeHeight(Math.min(Math.max(startH + delta, 60), 400));
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        }}
        style={{
          height: 8,
          cursor: 'row-resize',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <div style={{
          width: 36,
          height: 4,
          borderRadius: 2,
          backgroundColor: 'var(--t-divider)',
          transition: 'background-color 150ms',
        }} />
      </div>

      {/* ── New Messages Pill ── */}
      {showScrollPill && (
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          padding: '6px 0',
          flexShrink: 0,
        }}>
          <button
            onClick={() => scrollToBottom(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '5px 14px',
              borderRadius: 14,
              border: 'none',
              background: 'rgba(0,122,255,0.9)',
              color: '#fff',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              letterSpacing: '-0.01em',
              boxShadow: '0 2px 8px rgba(0,122,255,0.3)',
              transition: 'all 150ms ease',
            }}
          >
            <ChevronDown size={13} />
            New messages
          </button>
        </div>
      )}

      {/* ── Compose Bar (matches mobile exactly) ── */}
      <div style={{
        padding: '10px 14px 14px',
        flexShrink: 0,
      }}>
        {/* Pending file previews */}
        {pendingFiles.length > 0 && (
          <div style={{
            display: 'flex',
            gap: 8,
            paddingTop: 8,
            paddingBottom: 8,
            overflowX: 'auto',
          }}>
            {pendingFiles.map((f, idx) => (
              <div key={idx} style={{
                position: 'relative',
                flexShrink: 0,
                borderRadius: 10,
                overflow: 'hidden',
                border: '1px solid var(--t-divider)',
                background: 'var(--t-panel-translucent)',
              }}>
                {f.preview ? (
                  <img src={f.preview} alt={f.name} style={{
                    width: 64,
                    height: 64,
                    objectFit: 'cover',
                    display: 'block',
                  }} />
                ) : (
                  <div style={{
                    width: 64,
                    height: 64,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 10,
                    color: 'var(--t-text-secondary)',
                    textAlign: 'center',
                    padding: 4,
                    wordBreak: 'break-all',
                  }}>
                    {f.name.slice(0, 12)}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removePendingFile(idx)}
                  style={{
                    position: 'absolute',
                    top: 2,
                    right: 2,
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    border: 'none',
                    background: 'rgba(0,0,0,0.5)',
                    color: '#fff',
                    fontSize: 11,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    paddingTop: 0,
                    paddingRight: 0,
                    paddingBottom: 0,
                    paddingLeft: 0,
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

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
              height: composeHeight,
              minHeight: 60,
              maxHeight: 400,
              resize: 'none',
              transition: 'none',
            }}
          />

          {/* Action row */}
          <div className="remodex-compose-row">
            <button
              type="button"
              className="remodex-compose-chip remodex-compose-chip-icon"
              aria-label="Attach"
              onClick={() => fileInputRef.current?.click()}
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
            {agentRunning && !draft.trim() ? (
              <button
                type="button"
                disabled={stopping}
                onClick={() => void stopRun()}
                aria-label="Stop agent run"
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
                  border: '2px solid #ef4444',
                  background: stopping ? '#fef2f2' : 'rgba(239, 68, 68, 0.06)',
                  color: '#ef4444',
                  fontSize: '0.84rem',
                  fontWeight: 700,
                  cursor: stopping ? 'default' : 'pointer',
                  transition: 'all 150ms ease',
                }}
              >
                {stopping ? (
                  <Loader2 size={17} className="spin" />
                ) : (
                  <>
                    <Square size={14} strokeWidth={2.5} fill="#ef4444" />
                    <span>Stop</span>
                  </>
                )}
              </button>
            ) : (
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
                  background: chatSendDisabled ? 'var(--t-text-faint)' : '#ef4444',
                  color: chatSendDisabled ? 'var(--t-text-muted)' : '#ffffff',
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
            )}
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
          background: 'var(--t-chrome)',
          backdropFilter: 'blur(20px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(20px) saturate(1.4)',
          borderRadius: 999,
          border: '1px solid var(--t-divider-subtle)',
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
                  color: 'var(--t-text-secondary)',
                }}>
                  {pct}% used
                </span>
              </>
            );
          })()}

          <span style={{ color: 'var(--t-text-faint)', fontSize: 12 }}>·</span>

          {/* Branch */}
          <GitBranch size={12} strokeWidth={1.6} style={{ color: 'var(--t-text-muted)', flexShrink: 0 }} />
          <span style={{
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--t-text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {compactLine(selectedSession?.branch ?? 'main', 'main', 18)}
          </span>
        </div>
      </div>
      {diffOpen ? <DiffModal onClose={() => setDiffOpen(false)} /> : null}
    </div>
  );
}
