'use client';

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Plus, X, Terminal as TerminalIcon, ChevronDown, Crosshair } from 'lucide-react';
import { ChatBubble } from './ChatBubble';
import { saveTabState, loadTabState, checkAliveSessions, type PersistedTabState } from '@/lib/terminal/tab-state';
import {
  PREVIEW_HOST_MESSAGE_SOURCE,
  PREVIEW_MESSAGE_SOURCE,
  type PreviewSelectionPayload,
} from '@/lib/panel/preview';

/* ── Types ── */

export interface TerminalTab {
  id: string;
  label: string;
  kind: 'terminal' | 'chat';
  tmuxSession: string | null; // null = pending creation (terminal only)
  cliAgent?: string; // which CLI agent was launched (or 'shell')
  repo?: RegisteredRepo; // optional repo context
  createdAt: number; // timestamp for elapsed time
  lastActivity: number; // timestamp of last terminal output
  // Chat-specific fields
  chatRuntime?: 'codex' | 'claude-code' | 'openclaw';
  chatSessionKey?: string; // OpenClaw session key or CLI session ID
  chatMessages?: ChatMessage[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

/** Detected localhost dev server from terminal output */
interface LocalhostPreview {
  id: string;
  tabId: string;
  url: string;
  port: number;
  detectedAt: number;
}

/** Strip ANSI escape sequences from terminal output for URL detection */
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[^[]/g;

/** Detect localhost URLs in terminal output */
const LOCALHOST_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{3,5})\b[^\s)"]*/g;

/** Ports to ignore — the IDE itself runs on these */
const IGNORED_PORTS = new Set([3000, 3002]); // 3000 = Next.js dev, 3002 = WS server

export interface TerminalTabHandle {
  writeToTerminal: (sessionName: string, data: string) => void;
  writeRaw: (sessionName: string, data: string) => void;
  showImage: (sessionName: string, imageB64: string, filename: string) => void;
  setTermError: (sessionName: string, error: string) => void;
  setTermExited: (sessionName: string) => void;
  onSessionCreated: (sessionName: string) => void;
}

interface TerminalWorkspaceProps {
  sendTerminalCreate: (cols: number, rows: number) => void;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach: (sessionName: string) => void;
  termWsConnected: boolean;
  onPreviewSelection?: (selection: PreviewSelectionPayload) => void;
}

const CLI_AGENTS = [
  { id: 'shell', label: 'Terminal', color: '#64748b', command: null },
  { id: 'claude', label: 'Claude Code', color: '#e07a3a', command: 'claude' },
  { id: 'codex', label: 'Codex', color: '#6b7280', command: 'codex' },
  { id: 'gemini', label: 'Gemini CLI', color: '#4285f4', command: 'gemini' },
  { id: 'opencode', label: 'OpenCode', color: '#f97316', command: 'opencode' },
  { id: 'aider', label: 'Aider', color: '#eab308', command: 'aider' },
];

interface RegisteredRepo {
  name: string;
  localPath: string;
  remoteUrl?: string;
}

/** Small colored dot for tab/picker items */
function AgentDot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <span style={{
      display: 'inline-block',
      width: size,
      height: size,
      borderRadius: '50%',
      background: color,
      flexShrink: 0,
    }} />
  );
}

/* ── Inline xterm.js Terminal ── */

interface XtermPanelProps {
  tmuxSession: string;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach: (sessionName: string) => void;
  visible: boolean;
}

interface InlineImage {
  id: string;
  dataUrl: string;
  filename: string;
}

interface XtermPanelHandle {
  writeData: (data: string) => void;
  writeRaw: (data: string) => void;
  showImage: (imageB64: string, filename: string) => void;
  setError: (error: string) => void;
  setExited: () => void;
}

const XtermPanel = forwardRef<XtermPanelHandle, XtermPanelProps>(function XtermPanel(
  { tmuxSession, sendTerminalAttach, sendTerminalInput, sendTerminalResize, sendTerminalDetach, visible },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const termRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fitAddonRef = useRef<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  const [inlineImages, setInlineImages] = useState<InlineImage[]>([]);
  const imageCountRef = useRef(0);

  useImperativeHandle(ref, () => ({
    writeData: (data: string) => {
      if (!termRef.current) return;
      try {
        // Decode base64 → Uint8Array → proper UTF-8 (atob mangles multi-byte chars)
        const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        termRef.current.write(bytes);
      } catch { /* ignore decode errors */ }
    },
    showImage: (imageB64: string, filename: string) => {
      // Detect mime type from filename
      const ext = filename.split('.').pop()?.toLowerCase() ?? 'png';
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'svg' ? 'image/svg+xml' : 'image/png';
      const dataUrl = `data:${mime};base64,${imageB64}`;
      imageCountRef.current += 1;
      setInlineImages(prev => [...prev, { id: `img-${imageCountRef.current}`, dataUrl, filename }]);
      // Write a newline placeholder in xterm so the prompt moves down
      if (termRef.current) {
        termRef.current.write('\r\n\r\n');
      }
    },
    writeRaw: (data: string) => {
      if (!termRef.current) return;
      try {
        const encoder = new TextEncoder();
        termRef.current.write(encoder.encode(data));
      } catch { /* ignore */ }
    },
    setError: (err: string) => setError(err),
    setExited: () => setExited(true),
  }), []);

  // Refit when visibility changes
  useEffect(() => {
    if (visible && fitAddonRef.current) {
      // Small delay to let layout settle
      const t = setTimeout(() => {
        try {
          fitAddonRef.current?.fit();
          if (termRef.current) {
            sendTerminalResize(tmuxSession, termRef.current.cols, termRef.current.rows);
          }
        } catch { /* ignore */ }
      }, 50);
      return () => clearTimeout(t);
    }
  }, [visible, tmuxSession, sendTerminalResize]);

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;

    async function init() {
      try {
        const [{ Terminal }, { FitAddon }, { WebLinksAddon }, { SearchAddon }, { Unicode11Addon }, { ImageAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
          import('@xterm/addon-web-links'),
          import('@xterm/addon-search'),
          import('@xterm/addon-unicode11'),
          import('@xterm/addon-image'),
        ]);
        if (disposed) return;

        // Inject CSS once
        if (!document.getElementById('xterm-css')) {
          const link = document.createElement('link');
          link.id = 'xterm-css';
          link.rel = 'stylesheet';
          link.href = '/xterm.css';
          document.head.appendChild(link);
        }

        const term = new Terminal({
          fontFamily: 'ui-monospace, "SF Mono", Monaco, Menlo, monospace',
          fontSize: 12,
          lineHeight: 1.35,
          cursorBlink: true,
          cursorStyle: 'block',
          allowTransparency: true,
          allowProposedApi: true,
          scrollback: 10000,
          theme: {
            background: '#ffffff',
            foreground: '#1e293b',
            cursor: '#dc2626',
            cursorAccent: '#ffffff',
            selectionBackground: 'rgba(59, 130, 246, 0.18)',
            selectionForeground: '#0f172a',
            black: '#1e293b',
            red: '#dc2626',
            green: '#16a34a',
            yellow: '#ca8a04',
            blue: '#2563eb',
            magenta: '#9333ea',
            cyan: '#0891b2',
            white: '#f1f5f9',
            brightBlack: '#64748b',
            brightRed: '#ef4444',
            brightGreen: '#22c55e',
            brightYellow: '#eab308',
            brightBlue: '#3b82f6',
            brightMagenta: '#a855f7',
            brightCyan: '#06b6d4',
            brightWhite: '#ffffff',
          },
        });

        const fitAddon = new FitAddon();
        const webLinksAddon = new WebLinksAddon();
        const searchAddon = new SearchAddon();
        const unicode11Addon = new Unicode11Addon();
        const imageAddon = new ImageAddon({
          enableSizeReports: true,
          pixelLimit: 16777216, // 4096x4096 max
          sixelSupport: true,
          sixelScrolling: true,
          sixelPaletteLimit: 4096,
          iipSupport: true, // iTerm2 Inline Image Protocol
          iipSizeLimit: 20000000, // 20MB max image size
        });
        term.loadAddon(fitAddon);
        term.loadAddon(webLinksAddon);
        term.loadAddon(searchAddon);
        term.loadAddon(unicode11Addon);
        term.loadAddon(imageAddon);
        term.unicode.activeVersion = '11';

        if (!containerRef.current || disposed) { term.dispose(); return; }

        term.open(containerRef.current);
        fitAddon.fit();
        termRef.current = term;
        fitAddonRef.current = fitAddon;

        // Attach to tmux session
        sendTerminalAttach(tmuxSession, term.cols, term.rows);

        // Wire input
        term.onData((data) => { sendTerminalInput(tmuxSession, data); });

        // Auto-fit on resize
        const observer = new ResizeObserver(() => {
          if (disposed || !fitAddonRef.current) return;
          try {
            fitAddonRef.current.fit();
            sendTerminalResize(tmuxSession, termRef.current.cols, termRef.current.rows);
          } catch { /* ignore */ }
        });
        if (containerRef.current) observer.observe(containerRef.current);

        return () => { observer.disconnect(); };
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : 'Failed to load terminal');
      }
    }

    const cleanupPromise = init();

    return () => {
      disposed = true;
      sendTerminalDetach(tmuxSession);
      cleanupPromise?.then(cleanup => cleanup?.());
      if (termRef.current) { termRef.current.dispose(); termRef.current = null; }
      fitAddonRef.current = null;
    };
  }, [tmuxSession, sendTerminalAttach, sendTerminalInput, sendTerminalResize, sendTerminalDetach]);

  if (error) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#ef4444', fontSize: 13, fontFamily: 'ui-monospace, monospace',
      }}>
        Terminal error: {error}
      </div>
    );
  }

  if (exited) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#64748b', fontSize: 13, fontFamily: 'ui-monospace, monospace',
      }}>
        Session ended
      </div>
    );
  }

  return (
    <div style={{
      flex: 1,
      width: '100%',
      display: visible ? 'flex' : 'none',
      flexDirection: 'column',
      background: '#ffffff',
      borderRadius: 0,
      overflow: 'hidden',
    }}>
      {/* Inline images — rendered above terminal */}
      {inlineImages.map((img) => (
        <div key={img.id} style={{
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 12,
          paddingRight: 12,
          borderBottom: '1px solid #f1f5f9',
          flexShrink: 0,
        }}>
          <img
            src={img.dataUrl}
            alt={img.filename}
            style={{
              maxWidth: '100%',
              maxHeight: 400,
              borderRadius: 8,
              objectFit: 'contain',
            }}
          />
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4, fontFamily: 'ui-monospace, monospace' }}>
            {img.filename}
          </div>
        </div>
      ))}
      {/* Terminal */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          width: '100%',
          background: '#ffffff',
          paddingTop: 2,
          paddingLeft: 2,
        }}
      />
    </div>
  );
});

/* ── Tab Bar ── */

/* ── Localhost Preview Pane ── */

function PreviewToolbar({ preview, selectionEnabled, onToggleSelection, onRefresh, onClose }: {
  preview: LocalhostPreview;
  selectionEnabled: boolean;
  onToggleSelection: () => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      height: 32,
      paddingLeft: 12,
      paddingRight: 8,
      background: '#f1f5f9',
      borderBottom: '1px solid #e2e8f0',
      gap: 8,
      flexShrink: 0,
    }}>
      {/* Green dot — live */}
      <span style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: '#22c55e',
        flexShrink: 0,
      }} />
      {/* URL */}
      <span style={{
        fontSize: 11,
        color: '#64748b',
        fontFamily: 'ui-monospace, "SF Mono", Monaco, Menlo, monospace',
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {preview.url}
      </span>
      <button
        type="button"
        onClick={onToggleSelection}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 24,
          paddingTop: 0,
          paddingRight: 9,
          paddingBottom: 0,
          paddingLeft: 9,
          borderRadius: 999,
          border: selectionEnabled ? '1px solid rgba(37,99,235,0.28)' : '1px solid rgba(148,163,184,0.18)',
          background: selectionEnabled ? 'rgba(37,99,235,0.08)' : 'rgba(255,255,255,0.82)',
          color: selectionEnabled ? '#1d4ed8' : '#475569',
          cursor: 'pointer',
          fontSize: 11,
          fontWeight: 600,
          flexShrink: 0,
        }}
        title={selectionEnabled ? 'Element selection is active' : 'Select an element in the preview'}
      >
        <Crosshair size={12} />
        Select
      </button>
      {/* Refresh */}
      <button
        type="button"
        onClick={onRefresh}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          border: 'none',
          background: 'transparent',
          color: '#64748b',
          cursor: 'pointer',
          borderRadius: 4,
          fontSize: 14,
        }}
        title="Refresh"
      >
        ↻
      </button>
      {/* Close */}
      <button
        type="button"
        onClick={onClose}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          border: 'none',
          background: 'transparent',
          color: '#64748b',
          cursor: 'pointer',
          borderRadius: 4,
          fontSize: 14,
        }}
        title="Close preview"
      >
        ✕
      </button>
    </div>
  );
}

/* ── Workspace Chat Pane ── */

const WorkspaceChatPane = memo(function WorkspaceChatPane({ tab, onUpdateMessages }: {
  tab: TerminalTab;
  onUpdateMessages: (tabId: string, messages: ChatMessage[]) => void;
}) {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = useMemo(() => tab.chatMessages ?? [], [tab.chatMessages]);
  const tabId = tab.id;
  const chatRuntime = tab.chatRuntime;
  const chatSessionKey = tab.chatSessionKey;

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, streaming]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}-user`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    const updated = [...messages, userMsg];
      onUpdateMessages(tabId, updated);

    try {
      let endpoint = '';
      let body: Record<string, unknown> = {};

      if (chatRuntime === 'claude-code') {
        endpoint = '/api/claude-code/send';
        body = { message: text, sessionId: chatSessionKey };
      } else if (chatRuntime === 'codex') {
        endpoint = '/api/codex/send';
        body = { message: text, threadId: chatSessionKey };
      } else {
        // OpenClaw — use gateway send
        endpoint = '/api/panel/chat/send';
        body = { sessionKey: chatSessionKey || 'agent:main:main', message: text };
      }

      setStreaming(true);

      // Create placeholder assistant message for streaming
      const assistantId = `msg-${Date.now()}-assistant`;
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
      };
      let withAssistant = [...updated, assistantMsg];
      onUpdateMessages(tabId, withAssistant);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        withAssistant = withAssistant.map((m) =>
          m.id === assistantId ? { ...m, content: `Error ${res.status}: ${errText}` } : m
        );
        onUpdateMessages(tabId, withAssistant);
        return;
      }

      if (res.body) {
        // Stream SSE response
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
              };

              if (event.type === 'delta' && event.text) {
                accumulated += event.text;
                withAssistant = withAssistant.map((m) =>
                  m.id === assistantId ? { ...m, content: accumulated } : m
                );
                onUpdateMessages(tabId, withAssistant);
              }

              if (event.type === 'tool' && event.name) {
                accumulated += `\n🔧 *${event.name}*\n`;
                withAssistant = withAssistant.map((m) =>
                  m.id === assistantId ? { ...m, content: accumulated } : m
                );
                onUpdateMessages(tabId, withAssistant);
              }

              // Capture session ID for conversation continuity
              if (event.sessionId && chatRuntime === 'claude-code') {
                tab.chatSessionKey = event.sessionId;
              }

              if (event.type === 'done' || event.type === 'close') {
                if (event.text && !accumulated) {
                  accumulated = event.text;
                  withAssistant = withAssistant.map((m) =>
                    m.id === assistantId ? { ...m, content: accumulated } : m
                  );
                  onUpdateMessages(tabId, withAssistant);
                }
              }
            } catch { /* skip malformed lines */ }
          }
        }

        // If nothing accumulated, show fallback
        if (!accumulated) {
          withAssistant = withAssistant.map((m) =>
            m.id === assistantId ? { ...m, content: 'No response received' } : m
          );
          onUpdateMessages(tabId, withAssistant);
        }
      } else {
        // Non-streaming fallback
        const data = await res.json();
        withAssistant = withAssistant.map((m) =>
          m.id === assistantId ? { ...m, content: data.response ?? data.message ?? data.text ?? 'No response' } : m
        );
        onUpdateMessages(tabId, withAssistant);
      }
    } catch (err) {
      const errorMsg: ChatMessage = {
        id: `msg-${Date.now()}-error`,
        role: 'assistant',
        content: `Error: ${err instanceof Error ? err.message : 'Failed to send'}`,
        timestamp: Date.now(),
      };
      onUpdateMessages(tabId, [...updated, errorMsg]);
    } finally {
      setSending(false);
      setStreaming(false);
    }
  }, [input, sending, messages, tabId, chatRuntime, chatSessionKey, onUpdateMessages, tab]);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [slashSelected, setSlashSelected] = useState(0);
  const composeRef = useRef<HTMLDivElement>(null);

  // Slash commands
  const SLASH_COMMANDS = useMemo(() => [
    { cmd: '/help', desc: 'Show available commands' },
    { cmd: '/compact', desc: 'Compact conversation history' },
    { cmd: '/clear', desc: 'Clear terminal output' },
    { cmd: '/cost', desc: 'Show token usage' },
    { cmd: '/status', desc: 'Show agent status' },
    { cmd: '/review', desc: 'Review current changes' },
    { cmd: '/diff', desc: 'Show working diff' },
    { cmd: '/test', desc: 'Run tests' },
    { cmd: '/plan', desc: 'Create implementation plan' },
  ], []);

  const filteredSlash = useMemo(() => {
    if (!slashFilter) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter(c => c.cmd.includes(slashFilter.toLowerCase()));
  }, [slashFilter, SLASH_COMMANDS]);

  // Close attach menu on outside click
  useEffect(() => {
    if (!showAttachMenu) return;
    const handler = (e: MouseEvent) => {
      if (composeRef.current && !composeRef.current.contains(e.target as Node)) {
        setShowAttachMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showAttachMenu]);

  // ⌘F to open search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setSearchOpen(v => !v);
        setTimeout(() => searchRef.current?.focus(), 50);
      }
      if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false);
        setSearchQuery('');
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [searchOpen]);

  const filteredMessages = useMemo(() => {
    if (!searchQuery.trim()) return messages;
    const q = searchQuery.toLowerCase();
    return messages.filter(m => m.content.toLowerCase().includes(q));
  }, [messages, searchQuery]);

  const runtimeLabels = { 'codex': 'Codex', 'claude-code': 'Claude Code', 'openclaw': 'OpenClaw' };
  const runtimeColors = { 'codex': '#10b981', 'claude-code': '#8b5cf6', 'openclaw': '#ef4444' };
  const runtimeModels = { 'codex': 'GPT-5.4', 'claude-code': 'Opus 4.6', 'openclaw': 'Opus 4.6' };
  const runtimeThinking = { 'codex': 'High', 'claude-code': 'high', 'openclaw': 'high' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#ffffff' }}>
      {/* Header bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 16px',
        borderBottom: '1px solid #e2e8f0',
        flexShrink: 0,
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: runtimeColors[tab.chatRuntime ?? 'openclaw'],
          flexShrink: 0,
        }} />
        <span style={{
          fontSize: 13, fontWeight: 600,
          color: '#0f172a',
          fontFamily: '-apple-system, system-ui, sans-serif',
        }}>
          {runtimeLabels[tab.chatRuntime ?? 'openclaw']}
        </span>
        {tab.repo ? (
          <span style={{
            fontSize: 11, color: '#94a3b8',
            fontFamily: '"SF Mono", ui-monospace, monospace',
          }}>
            {tab.repo.name}
          </span>
        ) : null}
      </div>

      {/* Search bar (⌘F) */}
      {searchOpen && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 16px',
          borderBottom: '1px solid #e2e8f0',
          background: '#f8fafc',
          flexShrink: 0,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={searchRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.currentTarget.value)}
            placeholder="Search messages…"
            style={{
              flex: 1, border: 'none', background: 'transparent',
              fontSize: 13, outline: 'none', color: '#0f172a',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          />
          {searchQuery && (
            <span style={{ fontSize: 11, color: '#64748b', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
              {filteredMessages.length} result{filteredMessages.length !== 1 ? 's' : ''}
            </span>
          )}
          <button
            type="button"
            onClick={() => { setSearchOpen(false); setSearchQuery(''); }}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 20, height: 20, borderRadius: 4,
              border: 'none', background: 'rgba(0,0,0,0.05)',
              cursor: 'pointer', color: '#64748b', fontSize: 11,
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Messages area */}
      <div ref={scrollRef} style={{
        flex: 1,
        overflowY: 'auto',
        padding: '16px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}>
        {(searchQuery ? filteredMessages : messages).length === 0 ? (
          <div style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            color: '#94a3b8',
          }}>
            {searchQuery ? (
              <>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <span style={{ fontSize: 14, fontWeight: 500 }}>No results for &quot;{searchQuery}&quot;</span>
              </>
            ) : (
              <>
                <TerminalIcon size={32} strokeWidth={1} />
                <span style={{ fontSize: 14, fontWeight: 500 }}>
                  Start a conversation with {runtimeLabels[tab.chatRuntime ?? 'openclaw']}
                </span>
                <span style={{ fontSize: 12 }}>
                  Messages are scoped to this workspace tab
                </span>
              </>
            )}
          </div>
        ) : (
          (searchQuery ? filteredMessages : messages).map((msg: ChatMessage) => (
            <ChatBubble
              key={msg.id}
              message={msg}
              runtimeColor={runtimeColors[tab.chatRuntime ?? 'openclaw']}
            />
          ))
        )}
        {streaming ? (
          <div style={{
            display: 'flex',
            gap: 4,
            padding: '10px 14px',
            borderRadius: '14px 14px 14px 4px',
            background: '#f1f5f9',
            width: 'fit-content',
          }}>
            <span style={{ animation: 'pulse 1.5s ease-in-out infinite', width: 6, height: 6, borderRadius: '50%', background: '#94a3b8' }} />
            <span style={{ animation: 'pulse 1.5s ease-in-out 0.2s infinite', width: 6, height: 6, borderRadius: '50%', background: '#94a3b8' }} />
            <span style={{ animation: 'pulse 1.5s ease-in-out 0.4s infinite', width: 6, height: 6, borderRadius: '50%', background: '#94a3b8' }} />
          </div>
        ) : null}
      </div>

      {/* Compose bar */}
      <div ref={composeRef} style={{
        padding: '10px 16px',
        borderTop: '1px solid #e2e8f0',
        flexShrink: 0,
        position: 'relative',
      }}>
        {/* Slash command popover — drops DOWN into message area */}
        {showSlashMenu && filteredSlash.length > 0 && (
          <div style={{
            position: 'absolute',
            top: '100%',
            left: 16, right: 16,
            marginTop: 4,
            borderRadius: 10,
            background: 'rgba(255,255,255,0.75)',
            backdropFilter: 'blur(40px) saturate(1.8)',
            WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
            border: '1px solid rgba(255,255,255,0.3)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)',
            overflow: 'hidden',
            zIndex: 100,
          }}>
            {filteredSlash.map((cmd, i) => (
              <button
                key={cmd.cmd}
                type="button"
                onClick={() => {
                  setInput(cmd.cmd + ' ');
                  setShowSlashMenu(false);
                  setSlashFilter('');
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  width: '100%',
                  padding: '8px 14px',
                  border: 'none',
                  background: i === slashSelected ? 'rgba(37,99,235,0.08)' : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  transition: 'background 80ms ease',
                }}
                onMouseEnter={() => setSlashSelected(i)}
              >
                <span style={{
                  fontSize: 13, fontWeight: 600, color: '#0f172a',
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                  minWidth: 80,
                }}>
                  {cmd.cmd}
                </span>
                <span style={{ fontSize: 12, color: '#64748b' }}>
                  {cmd.desc}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Attach popover (glass) — drops DOWN */}
        {showAttachMenu && (
          <div style={{
            position: 'absolute',
            top: '100%',
            left: 16,
            marginTop: 4,
            borderRadius: 10,
            background: 'rgba(255,255,255,0.75)',
            backdropFilter: 'blur(40px) saturate(1.8)',
            WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
            border: '1px solid rgba(255,255,255,0.3)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)',
            overflow: 'hidden',
            zIndex: 100,
            minWidth: 180,
          }}>
            {[
              { icon: 'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48', label: 'Attach file' },
              { icon: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z M12 13m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0', label: 'Attach image' },
              { icon: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2 M9 2h6v4H9z', label: 'Paste from clipboard' },
              { icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8', label: 'Add context file' },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => setShowAttachMenu(false)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  width: '100%',
                  padding: '8px 14px',
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  transition: 'background 80ms ease',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.04)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d={item.icon} />
                </svg>
                <span style={{ fontSize: 13, fontWeight: 500, color: '#0f172a' }}>
                  {item.label}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Input row */}
        <div style={{
          display: 'flex', gap: 8, alignItems: 'flex-end',
        }}>
          <div style={{
            flex: 1,
            borderRadius: 12,
            border: '1px solid #e2e8f0',
            background: '#f8fafc',
            overflow: 'hidden',
            transition: 'border-color 150ms ease',
          }}>
            <textarea
              value={input}
              onChange={(e) => {
                const val = e.currentTarget.value;
                setInput(val);
                // Auto-resize
                e.currentTarget.style.height = 'auto';
                e.currentTarget.style.height = Math.min(e.currentTarget.scrollHeight, 120) + 'px';
                // Slash command detection
                if (val === '/') {
                  setShowSlashMenu(true);
                  setSlashFilter('');
                  setSlashSelected(0);
                } else if (val.startsWith('/') && !val.includes(' ')) {
                  setShowSlashMenu(true);
                  setSlashFilter(val);
                  setSlashSelected(0);
                } else {
                  setShowSlashMenu(false);
                }
              }}
              onKeyDown={(e) => {
                if (showSlashMenu) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setSlashSelected(s => Math.min(s + 1, filteredSlash.length - 1));
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setSlashSelected(s => Math.max(s - 1, 0));
                    return;
                  }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    if (filteredSlash[slashSelected]) {
                      setInput(filteredSlash[slashSelected].cmd + ' ');
                      setShowSlashMenu(false);
                      setSlashFilter('');
                    }
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setShowSlashMenu(false);
                    return;
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={`Message ${runtimeLabels[tab.chatRuntime ?? 'openclaw']}… (/ for commands)`}
              disabled={sending}
              rows={1}
              style={{
                width: '100%',
                padding: '10px 14px',
                border: 'none',
                background: 'transparent',
                fontSize: 13,
                fontFamily: '-apple-system, system-ui, sans-serif',
                outline: 'none',
                color: '#0f172a',
                resize: 'none',
                lineHeight: 1.5,
                maxHeight: 120,
              }}
            />
          </div>
          <button
            type="button"
            onClick={handleSend}
            disabled={sending || !input.trim()}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 36,
              height: 36,
              borderRadius: 10,
              border: 'none',
              background: input.trim() ? runtimeColors[tab.chatRuntime ?? 'openclaw'] : '#e2e8f0',
              color: input.trim() ? '#ffffff' : '#94a3b8',
              cursor: input.trim() ? 'pointer' : 'default',
              transition: 'all 150ms ease',
              flexShrink: 0,
              marginBottom: 2,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
        {/* Bottom row: model + thinking + attach + search */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          paddingTop: 6, paddingLeft: 2,
          fontSize: 11, color: '#64748b',
        }}>
          {/* Model indicator */}
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            fontWeight: 600, fontSize: 11,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            {runtimeModels[tab.chatRuntime ?? 'openclaw']}
          </span>
          <span style={{ color: '#e2e8f0' }}>·</span>
          {/* Thinking level */}
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            fontWeight: 600, fontSize: 11, color: '#f59e0b',
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}>
              <path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z" />
              <path d="M9 21h6" />
            </svg>
            {runtimeThinking[tab.chatRuntime ?? 'openclaw']}
          </span>

          <span style={{ flex: 1 }} />

          {/* Attach button (opens glass popover) */}
          <button
            type="button"
            onClick={() => setShowAttachMenu(v => !v)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '2px 8px',
              borderRadius: 5,
              border: '1px solid #e2e8f0',
              background: showAttachMenu ? 'rgba(0,0,0,0.06)' : '#f1f5f9',
              cursor: 'pointer', color: '#64748b',
              fontSize: 10, fontWeight: 600,
              fontFamily: '-apple-system, system-ui, sans-serif',
              transition: 'all 120ms ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.06)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = showAttachMenu ? 'rgba(0,0,0,0.06)' : '#f1f5f9'; }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Attach
          </button>

          {/* ⌘F search */}
          <kbd
            onClick={() => { setSearchOpen(true); setTimeout(() => searchRef.current?.focus(), 50); }}
            style={{
              fontSize: 9, fontWeight: 500,
              padding: '1px 4px', borderRadius: 3,
              border: '1px solid #e2e8f0',
              background: '#f1f5f9',
              color: '#94a3b8',
              cursor: 'pointer',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            ⌘F
          </kbd>
        </div>
      </div>
    </div>
  );
});

const PreviewPane = memo(function PreviewPane({ previews, onElementSelect, onRefresh, onClose }: {
  previews: LocalhostPreview[];
  onElementSelect?: (selection: PreviewSelectionPayload) => void;
  onRefresh: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const iframeRefs = useRef<Map<string, HTMLIFrameElement>>(new Map());
  const [selectionModes, setSelectionModes] = useState<Record<string, boolean>>({});

  const syncSelectionMode = useCallback((previewId: string, enabled: boolean) => {
    const iframe = iframeRefs.current.get(previewId);
    iframe?.contentWindow?.postMessage({
      source: PREVIEW_HOST_MESSAGE_SOURCE,
      type: 'selection-mode',
      enabled,
    }, window.location.origin);
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as {
        source?: string;
        type?: string;
        enabled?: boolean;
        selection?: PreviewSelectionPayload;
      };
      if (!data || data.source !== PREVIEW_MESSAGE_SOURCE) return;

      const preview = previews.find((item) => iframeRefs.current.get(item.id)?.contentWindow === event.source);
      if (!preview) return;

      if (data.type === 'ready') {
        syncSelectionMode(preview.id, Boolean(selectionModes[preview.id]));
        return;
      }

      if (data.type === 'selection-mode') {
        setSelectionModes((prev) => ({ ...prev, [preview.id]: Boolean(data.enabled) }));
        return;
      }

      if (data.type === 'selection' && data.selection) {
        onElementSelect?.(data.selection);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onElementSelect, previews, selectionModes, syncSelectionMode]);

  if (previews.length === 0) return null;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'row',
      flex: 1,
      minHeight: 0,
      gap: 1,
      background: '#e2e8f0',
    }}>
      {previews.map((p) => (
        <div key={p.id} style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          background: '#ffffff',
        }}>
          <PreviewToolbar
            preview={p}
            selectionEnabled={Boolean(selectionModes[p.id])}
            onToggleSelection={() => {
              setSelectionModes((prev) => {
                const enabled = !prev[p.id];
                syncSelectionMode(p.id, enabled);
                return { ...prev, [p.id]: enabled };
              });
            }}
            onRefresh={() => {
              const iframe = iframeRefs.current.get(p.id);
              if (iframe) {
                // Force reload by resetting src
                const src = iframe.src;
                iframe.src = '';
                setTimeout(() => { iframe.src = src; }, 50);
              }
              onRefresh(p.id);
            }}
            onClose={() => onClose(p.id)}
          />
          <iframe
            ref={(el) => {
              if (el) iframeRefs.current.set(p.id, el);
              else iframeRefs.current.delete(p.id);
            }}
            src={`/api/panel/proxy?url=${encodeURIComponent(p.url.replace('0.0.0.0', 'localhost'))}`}
            title={`Preview ${p.url}`}
            onLoad={() => syncSelectionMode(p.id, Boolean(selectionModes[p.id]))}
            style={{
              flex: 1,
              border: 'none',
              width: '100%',
              background: '#ffffff',
            }}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        </div>
      ))}
    </div>
  );
});

/** Format elapsed time: 0s → 59s, 1m → 59m, 1h → 99h */
function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h`;
}

/** Live activity dot + elapsed time for a tab */
function ActivityIndicator({ tab }: { tab: TerminalTab }) {
  const [now, setNow] = useState(() => tab.createdAt);

  // Tick every second for elapsed time
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const elapsed = now - tab.createdAt;
  const timeSinceActivity = now - tab.lastActivity;
  const isActive = timeSinceActivity < 3000; // active if output in last 3s

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      marginLeft: 2,
    }}>
      {/* Activity dot */}
      <span style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: isActive ? '#22c55e' : '#cbd5e1',
        transition: 'background 300ms',
        animation: isActive ? 'pulse-dot 1.5s ease-in-out infinite' : 'none',
        flexShrink: 0,
      }} />
      {/* Elapsed time */}
      <span style={{
        fontSize: 10,
        color: '#94a3b8',
        fontWeight: 400,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {formatElapsed(elapsed)}
      </span>
    </span>
  );
}

const TabBar = memo(function TabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onNewChatTab,
  onRegisterRepo,
}: {
  tabs: TerminalTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: (agentId: string, repo?: RegisteredRepo) => void;
  onNewChatTab: (runtime: 'codex' | 'claude-code' | 'openclaw', repo?: RegisteredRepo) => void;
  onRegisterRepo?: (localPath: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerStep, setPickerStep] = useState<'agent' | 'repo'>('agent');
  const [selectedAgent, setSelectedAgent] = useState<typeof CLI_AGENTS[0] | null>(null);
  const [repos, setRepos] = useState<RegisteredRepo[]>([]);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close picker on outside click
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
        setPickerStep('agent');
        setSelectedAgent(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerOpen]);

  // Fetch repos when picker opens
  useEffect(() => {
    if (!pickerOpen) return;
    fetch('/api/panel/repos')
      .then(r => r.json())
      .then(data => setRepos(data.repos ?? []))
      .catch(() => setRepos([]));
  }, [pickerOpen]);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'stretch',
      height: 36,
      marginTop: 0,
      background: '#f8fafc',
      borderBottom: 'none',
      flexShrink: 0,
      overflow: 'visible',
      zIndex: 10,
      position: 'relative',
    }}>
      {/* Tabs */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', gap: 0 }}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const agent = CLI_AGENTS.find(a => a.id === tab.cliAgent);
          return (
            <button
              type="button"
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                paddingTop: 0,
                paddingRight: 12,
                paddingBottom: 0,
                paddingLeft: 12,
                height: '100%',
                border: 'none',
                borderRight: '1px solid #e2e8f0',
                background: isActive ? '#ffffff' : 'transparent',
                color: isActive ? '#0f172a' : '#64748b',
                fontSize: 12,
                fontWeight: isActive ? 600 : 400,
                fontFamily: 'ui-monospace, "SF Mono", Monaco, Menlo, monospace',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: 'background 100ms, color 100ms',
                borderBottom: isActive ? '2px solid #93c5fd' : '2px solid transparent',
              }}
            >
              {tab.kind === 'chat' ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={
                  tab.chatRuntime === 'codex' ? '#10b981' : tab.chatRuntime === 'claude-code' ? '#8b5cf6' : '#ef4444'
                } strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              ) : tab.cliAgent === 'shell' ? (
                <TerminalIcon size={12} style={{ color: '#94a3b8' }} />
              ) : (
                <AgentDot color={agent?.color ?? '#64748b'} />
              )}
              <span>{tab.label}</span>
              <ActivityIndicator tab={tab} />
              {tabs.length > 1 && (
                <span
                  onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onCloseTab(tab.id); } }}
                  role="button"
                  tabIndex={0}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 16,
                    height: 16,
                    borderRadius: 4,
                    marginLeft: 4,
                    color: '#475569',
                    cursor: 'pointer',
                    transition: 'background 100ms, color 100ms',
                  }}
                  onMouseEnter={(e) => {
                    (e.target as HTMLElement).style.background = 'rgba(239, 68, 68, 0.15)';
                    (e.target as HTMLElement).style.color = '#ef4444';
                  }}
                  onMouseLeave={(e) => {
                    (e.target as HTMLElement).style.background = 'transparent';
                    (e.target as HTMLElement).style.color = '#475569';
                  }}
                >
                  <X size={10} />
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* + Button with CLI picker */}
      <div ref={pickerRef} style={{ position: 'relative', flexShrink: 0 }}>
        <button
          type="button"
          onClick={() => setPickerOpen(!pickerOpen)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            height: '100%',
            paddingTop: 0,
            paddingRight: 10,
            paddingBottom: 0,
            paddingLeft: 10,
            border: 'none',
            background: 'transparent',
            color: '#94a3b8',
            fontSize: 12,
            cursor: 'pointer',
            transition: 'color 100ms',
          }}
          onMouseEnter={(e) => { (e.target as HTMLElement).style.color = '#3b82f6'; }}
          onMouseLeave={(e) => { (e.target as HTMLElement).style.color = '#94a3b8'; }}
        >
          <Plus size={14} />
          <ChevronDown size={10} />
        </button>

        {/* Picker dropdown */}
        {pickerOpen && (
          <div style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            zIndex: 9000,
            marginTop: 4,
            minWidth: 220,
            background: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: 10,
            overflow: 'hidden',
            boxShadow: '0 12px 40px rgba(0, 0, 0, 0.12)',
          }}>
            {/* Step 1: Pick a CLI agent */}
            {pickerStep === 'agent' && (<>
              <div style={{
                paddingTop: 8,
                paddingRight: 10,
                paddingBottom: 4,
                paddingLeft: 10,
                fontSize: 10,
                fontWeight: 600,
                color: '#94a3b8',
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
              }}>
                New Terminal
              </div>
              {CLI_AGENTS.map((agent) => (
                <button
                  type="button"
                  key={agent.id}
                  onClick={() => {
                    if (agent.id === 'shell') {
                      // Shell — launch directly in home dir
                      onNewTab(agent.id);
                      setPickerOpen(false);
                      setPickerStep('agent');
                    } else {
                      // CLI agent — always show repo picker (even with 0 repos)
                      setSelectedAgent(agent);
                      setPickerStep('repo');
                    }
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    paddingTop: 8,
                    paddingRight: 12,
                    paddingBottom: 8,
                    paddingLeft: 12,
                    border: 'none',
                    background: 'transparent',
                    color: '#1e293b',
                    fontSize: 13,
                    fontFamily: '-apple-system, system-ui, sans-serif',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background 100ms',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget).style.background = '#f1f5f9'; }}
                  onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; }}
                >
                  <span style={{ width: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {agent.id === 'shell' ? (
                      <TerminalIcon size={14} style={{ color: '#94a3b8' }} />
                    ) : (
                      <AgentDot color={agent.color} size={10} />
                    )}
                  </span>
                  <div>
                    <div style={{ fontWeight: 500 }}>{agent.label}</div>
                    {agent.command && (
                      <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'ui-monospace, monospace' }}>
                        $ {agent.command}
                      </div>
                    )}
                  </div>
                </button>
              ))}
              {/* Chat section divider */}
              <div style={{
                paddingTop: 8,
                paddingRight: 10,
                paddingBottom: 4,
                paddingLeft: 10,
                fontSize: 10,
                fontWeight: 600,
                color: '#94a3b8',
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
                borderTop: '1px solid #f1f5f9',
                marginTop: 4,
              }}>
                New Chat
              </div>
              {([
                { id: 'codex' as const, label: 'Codex', color: '#10b981' },
                { id: 'claude-code' as const, label: 'Claude Code', color: '#8b5cf6' },
                { id: 'openclaw' as const, label: 'OpenClaw', color: '#ef4444' },
              ]).map((rt) => (
                <button
                  type="button"
                  key={`chat-${rt.id}`}
                  onClick={() => {
                    onNewChatTab(rt.id);
                    setPickerOpen(false);
                    setPickerStep('agent');
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    paddingTop: 8,
                    paddingRight: 12,
                    paddingBottom: 8,
                    paddingLeft: 12,
                    border: 'none',
                    background: 'transparent',
                    color: '#1e293b',
                    fontSize: 13,
                    fontFamily: '-apple-system, system-ui, sans-serif',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background 100ms',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget).style.background = '#f1f5f9'; }}
                  onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; }}
                >
                  <span style={{ width: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <AgentDot color={rt.color} size={10} />
                  </span>
                  <div>
                    <div style={{ fontWeight: 500 }}>{rt.label}</div>
                    <div style={{ fontSize: 11, color: '#94a3b8' }}>Chat interface</div>
                  </div>
                </button>
              ))}
            </>)}

            {/* Step 2: Pick a repo (or launch without repo) */}
            {pickerStep === 'repo' && selectedAgent && (<>
              <button
                type="button"
                onClick={() => { setPickerStep('agent'); setSelectedAgent(null); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  width: '100%',
                  paddingTop: 6,
                  paddingRight: 10,
                  paddingBottom: 6,
                  paddingLeft: 10,
                  border: 'none',
                  borderBottom: '1px solid #f1f5f9',
                  background: 'transparent',
                  color: '#94a3b8',
                  fontSize: 11,
                  cursor: 'pointer',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                }}
              >
                ← {selectedAgent.label}
              </button>
              <div style={{
                paddingTop: 6,
                paddingRight: 10,
                paddingBottom: 4,
                paddingLeft: 10,
                fontSize: 10,
                fontWeight: 600,
                color: '#94a3b8',
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
              }}>
                Select Repo
              </div>

              {/* No repo — launch in home dir */}
              <button
                type="button"
                onClick={() => {
                  onNewTab(selectedAgent.id);
                  setPickerOpen(false);
                  setPickerStep('agent');
                  setSelectedAgent(null);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  paddingTop: 8,
                  paddingRight: 12,
                  paddingBottom: 8,
                  paddingLeft: 12,
                  border: 'none',
                  background: 'transparent',
                  color: '#64748b',
                  fontSize: 13,
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  transition: 'background 100ms',
                }}
                onMouseEnter={(e) => { (e.currentTarget).style.background = '#f1f5f9'; }}
                onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; }}
              >
                <TerminalIcon size={14} style={{ color: '#94a3b8' }} />
                <div>
                  <div style={{ fontWeight: 500 }}>No repo (home dir)</div>
                  <div style={{ fontSize: 11, color: '#94a3b8' }}>~/</div>
                </div>
              </button>

              {/* Registered repos */}
              {repos.length > 0 && (
                <div style={{
                  paddingTop: 6,
                  paddingRight: 10,
                  paddingBottom: 4,
                  paddingLeft: 10,
                  fontSize: 10,
                  fontWeight: 600,
                  color: '#94a3b8',
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                }}>
                  Repos
                </div>
              )}
              {repos.map((repo) => (
                <button
                  type="button"
                  key={repo.localPath}
                  onClick={() => {
                    onNewTab(selectedAgent.id, repo);
                    setPickerOpen(false);
                    setPickerStep('agent');
                    setSelectedAgent(null);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    paddingTop: 8,
                    paddingRight: 12,
                    paddingBottom: 8,
                    paddingLeft: 12,
                    border: 'none',
                    background: 'transparent',
                    color: '#1e293b',
                    fontSize: 13,
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                    transition: 'background 100ms',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget).style.background = '#f1f5f9'; }}
                  onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; }}
                >
                  <AgentDot color={selectedAgent.color} size={8} />
                  <div>
                    <div style={{ fontWeight: 500 }}>{repo.name}</div>
                    <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'ui-monospace, monospace' }}>
                      {repo.localPath.replace(/^\/Users\/[^/]+\//, '~/')}
                    </div>
                  </div>
                </button>
              ))}

              {/* Divider */}
              <div style={{ height: 1, background: '#f1f5f9', marginTop: 4, marginBottom: 4 }} />

              {/* Open folder — native dialog */}
              <button
                type="button"
                onClick={async () => {
                  let folderPath: string | null = null;

                  // Try Tauri native dialog first (gives real filesystem path)
                  try {
                    const { open } = await import('@tauri-apps/plugin-dialog');
                    const result = await open({ directory: true, title: 'Select project folder' });
                    if (typeof result === 'string') folderPath = result;
                  } catch {
                    // Not in Tauri (browser dev mode) — use server-side folder picker
                    try {
                      const res = await fetch('/api/panel/browse-folder', { method: 'POST' });
                      const data = await res.json();
                      if (data.path) folderPath = data.path;
                    } catch {
                      // Last resort
                      folderPath = window.prompt('Enter folder path:');
                    }
                  }

                  if (folderPath && selectedAgent) {
                    const folderName = folderPath.split('/').filter(Boolean).pop() ?? 'folder';
                    onNewTab(selectedAgent.id, { name: folderName, localPath: folderPath });
                    // Auto-register so it shows under Repos next time
                    onRegisterRepo?.(folderPath);
                    setPickerOpen(false);
                    setPickerStep('agent');
                    setSelectedAgent(null);
                  }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  paddingTop: 8,
                  paddingRight: 12,
                  paddingBottom: 8,
                  paddingLeft: 12,
                  border: 'none',
                  background: 'transparent',
                  color: '#1e293b',
                  fontSize: 13,
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  transition: 'background 100ms',
                }}
                onMouseEnter={(e) => { (e.currentTarget).style.background = '#f1f5f9'; }}
                onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; }}
              >
                <span style={{ fontSize: 14, color: '#94a3b8', width: 20, textAlign: 'center' }}>📂</span>
                <div style={{ fontWeight: 500 }}>Open folder...</div>
              </button>
            </>)}
          </div>
        )}
      </div>
    </div>
  );
});

/* ── Main Component ── */

export const TerminalWorkspace = forwardRef<TerminalTabHandle, TerminalWorkspaceProps>(
  function TerminalWorkspace(
    {
      sendTerminalCreate,
      sendTerminalAttach,
      sendTerminalInput,
      sendTerminalResize,
      sendTerminalDetach,
      termWsConnected,
      onPreviewSelection,
    },
    ref,
  ) {
    const [tabs, setTabs] = useState<TerminalTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string>('');
    const [previews, setPreviews] = useState<LocalhostPreview[]>([]);
    const tabsRef = useRef<TerminalTab[]>([]);
    const panelRefs = useRef<Map<string, XtermPanelHandle>>(new Map());
    const tabCountRef = useRef(0);
    const pendingCliCommands = useRef<Map<string, string>>(new Map()); // tabId → command to run after session created
    const initialCreatedRef = useRef(false);
    const restoredRef = useRef(false);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const detectedPortsRef = useRef<Set<number>>(new Set()); // avoid duplicate detections
    const urlDetectionEnabledRef = useRef(false); // suppress during initial replay

    // Persist tab state (debounced — saves 500ms after last change)
    const persistTabs = useCallback((currentTabs: TerminalTab[], currentActiveId: string) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        const persisted: PersistedTabState = {
          version: 1,
          activeTabId: currentActiveId,
          tabs: currentTabs.map(t => ({
            id: t.id,
            label: t.label,
            cliAgent: t.cliAgent ?? 'shell',
            repoName: t.repo?.name,
            repoPath: t.repo?.localPath,
            tmuxSession: t.tmuxSession ?? undefined,
          })),
          savedAt: new Date().toISOString(),
        };
        saveTabState(persisted);
      }, 500);
    }, []);

    // Save whenever tabs or active tab changes
    useEffect(() => {
      tabsRef.current = tabs;
      if (tabs.length > 0) {
        persistTabs(tabs, activeTabId);
      }
    }, [tabs, activeTabId, persistTabs]);

    // Restore tabs on WS connect (or create default shell tab)
    useEffect(() => {
      if (!termWsConnected || restoredRef.current) return;
      restoredRef.current = true;

      // Suppress URL detection for 5s to skip replay of old terminal output
      urlDetectionEnabledRef.current = false;
      setTimeout(() => { urlDetectionEnabledRef.current = true; }, 5000);

      (async () => {
        const saved = await loadTabState();

        if (saved && saved.tabs.length > 0) {
          // Check which tmux sessions are still alive
          const tmuxNames = saved.tabs.map(t => t.tmuxSession).filter(Boolean) as string[];
          const alive = await checkAliveSessions(tmuxNames);

          const restoredTabs: TerminalTab[] = [];
          for (const st of saved.tabs) {
            tabCountRef.current += 1;
            const tabId = `tab-${tabCountRef.current}`;

            const now = Date.now();
            if (st.tmuxSession && alive.has(st.tmuxSession)) {
              // Tmux session survived — reattach directly
              restoredTabs.push({
                id: tabId,
                label: st.label,
                kind: 'terminal',
                tmuxSession: st.tmuxSession,
                cliAgent: st.cliAgent,
                repo: st.repoPath ? { name: st.repoName ?? 'repo', localPath: st.repoPath } : undefined,
                createdAt: now,
                lastActivity: now,
              });
              // Attach to the existing session
              sendTerminalAttach(st.tmuxSession, 120, 30);
            } else {
              // Tmux session died — create a new shell in the same directory
              restoredTabs.push({
                id: tabId,
                label: st.label,
                kind: 'terminal',
                tmuxSession: null, // will be assigned when session created
                cliAgent: 'shell', // don't auto-restart agents (could be destructive)
                repo: st.repoPath ? { name: st.repoName ?? 'repo', localPath: st.repoPath } : undefined,
                createdAt: now,
                lastActivity: now,
              });
            }
          }

          setTabs(restoredTabs);
          // Set active tab — try to match saved, otherwise first tab
          const activeMatch = restoredTabs.find(t => t.id === saved.activeTabId);
          setActiveTabId(activeMatch?.id ?? restoredTabs[0]?.id ?? '');

          // Create new sessions for tabs that need them
          const deadTabs = restoredTabs.filter(t => t.tmuxSession === null);
          for (const deadTab of deadTabs) {
            void deadTab;
            sendTerminalCreate(120, 30);
          }
        } else {
          // No saved state — create default shell tab
          sendTerminalCreate(120, 30);
        }
      })();
    }, [termWsConnected, sendTerminalCreate, sendTerminalAttach]);

    // Reset restored flag when WS disconnects
    useEffect(() => {
      if (!termWsConnected) {
        restoredRef.current = false;
        initialCreatedRef.current = false;
      }
    }, [termWsConnected]);

    // Called when WS server confirms a new tmux session was created
    const handleSessionCreated = useCallback((sessionName: string) => {
      setTabs(prev => {
        // Check if there's a tab waiting for a session (tmuxSession === null)
        const pendingIdx = prev.findIndex(t => t.tmuxSession === null);
        if (pendingIdx >= 0) {
          const updated = [...prev];
          const tab = updated[pendingIdx];
          updated[pendingIdx] = { ...tab, tmuxSession: sessionName };
          // If this is a restored tab with a repo, cd into it
          if (tab.repo?.localPath) {
            fetch('/api/panel/terminal-exec', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionName, command: `cd ${tab.repo.localPath}` }),
            }).catch(() => {});
          }
          return updated;
        }
        // No pending tab — this is the initial auto-created session
        tabCountRef.current += 1;
        const now = Date.now();
        const newTab: TerminalTab = {
          id: `tab-${tabCountRef.current}`,
          label: 'Shell',
          kind: 'terminal',
          tmuxSession: sessionName,
          cliAgent: 'shell',
          createdAt: now,
          lastActivity: now,
        };
        return [...prev, newTab];
      });
      setActiveTabId(prev => prev || `tab-${tabCountRef.current}`);
    }, []);

    // Route terminal events to the correct tab's XtermPanel
    useImperativeHandle(ref, () => ({
      writeToTerminal: (sessionName: string, data: string) => {
        panelRefs.current.get(sessionName)?.writeData(data);
        // Track activity for the live dot
        const now = Date.now();
        setTabs(prev => prev.map(t =>
          t.tmuxSession === sessionName ? { ...t, lastActivity: now } : t
        ));

        // Scan for localhost URLs (skip during first 5s to ignore replayed history)
        if (urlDetectionEnabledRef.current) try {
          // Decode base64 → bytes → UTF-8 string for reliable regex matching
          const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
          const raw = new TextDecoder().decode(bytes);
          const clean = raw.replace(ANSI_RE, '');
          // Reset regex lastIndex (global regex retains state)
          LOCALHOST_RE.lastIndex = 0;
          const matches = clean.matchAll(LOCALHOST_RE);
          for (const match of matches) {
            const port = parseInt(match[1], 10);
            console.log(`[terminal] Detected localhost:${port} → ${match[0]}`);
            if (IGNORED_PORTS.has(port)) { console.log(`[terminal] Skipping port ${port} (IDE port)`); continue; }
            if (detectedPortsRef.current.has(port)) { console.log(`[terminal] Skipping port ${port} (already detected)`); continue; }
            detectedPortsRef.current.add(port);

            // Find which tab this session belongs to
            const tab = tabsRef.current.find(t => t.tmuxSession === sessionName);
            let url = match[0].replace('0.0.0.0', 'localhost');
            // Ensure http:// prefix
            if (!url.startsWith('http')) url = `http://${url}`;

            const newPreview: LocalhostPreview = {
              id: `preview-${port}`,
              tabId: tab?.id ?? '',
              url,
              port,
              detectedAt: now,
            };
            console.log(`[terminal] Adding preview:`, newPreview);
            setPreviews(prev => {
              if (prev.some(p => p.port === port)) return prev;
              const updated = [...prev, newPreview];
              console.log(`[terminal] Previews now:`, updated.length);
              return updated;
            });
          }
        } catch { /* ignore decode errors */ }
      },
      writeRaw: (sessionName: string, data: string) => {
        panelRefs.current.get(sessionName)?.writeRaw(data);
      },
      showImage: (sessionName: string, imageB64: string, filename: string) => {
        panelRefs.current.get(sessionName)?.showImage(imageB64, filename);
      },
      setTermError: (sessionName: string, error: string) => {
        panelRefs.current.get(sessionName)?.setError(error);
      },
      setTermExited: (sessionName: string) => {
        panelRefs.current.get(sessionName)?.setExited();
      },
      onSessionCreated: handleSessionCreated,
    }), [handleSessionCreated]);

    // Auto-register a folder so it shows in the picker next time
    const handleRegisterRepo = useCallback((localPath: string) => {
      fetch('/api/panel/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', localPath }),
      }).catch(() => { /* silently fail — non-critical */ });
    }, []);

    const handleNewTab = useCallback((agentId: string, repo?: RegisteredRepo) => {
      const agent = CLI_AGENTS.find(a => a.id === agentId);
      if (!agent) return;

      tabCountRef.current += 1;
      const tabId = `tab-${tabCountRef.current}`;
      const label = repo ? `${agent.label} · ${repo.name}` : agent.label;
      const now = Date.now();
      const newTab: TerminalTab = {
        id: tabId,
        label,
        kind: 'terminal',
        tmuxSession: null,
        cliAgent: agentId,
        repo,
        createdAt: now,
        lastActivity: now,
      };

      // Queue CLI command + optional cd to repo
      if (agent.command || repo) {
        const parts: string[] = [];
        if (repo) parts.push(`cd ${repo.localPath}`);
        if (agent.command) parts.push(agent.command);
        pendingCliCommands.current.set(tabId, parts.join(' && '));
      }

      setTabs(prev => [...prev, newTab]);
      setActiveTabId(tabId);
      sendTerminalCreate(120, 30);
    }, [sendTerminalCreate]);

    const handleNewChatTab = useCallback((runtime: 'codex' | 'claude-code' | 'openclaw', repo?: RegisteredRepo) => {
      tabCountRef.current += 1;
      const tabId = `chat-${tabCountRef.current}`;
      const runtimeLabels = { 'codex': 'Codex', 'claude-code': 'Claude Code', 'openclaw': 'OpenClaw' };
      const label = repo ? `${runtimeLabels[runtime]} · ${repo.name}` : runtimeLabels[runtime];
      const now = Date.now();
      const newTab: TerminalTab = {
        id: tabId,
        label,
        kind: 'chat',
        tmuxSession: null,
        chatRuntime: runtime,
        repo,
        createdAt: now,
        lastActivity: now,
        chatMessages: [],
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(tabId);
    }, []);

    const handleCloseTab = useCallback((tabId: string) => {
      setTabs(prev => {
        const idx = prev.findIndex(t => t.id === tabId);
        if (idx < 0) return prev;
        const tab = prev[idx];
        // Detach from tmux
        if (tab.tmuxSession) {
          sendTerminalDetach(tab.tmuxSession);
          panelRefs.current.delete(tab.tmuxSession);
        }
        const remaining = prev.filter(t => t.id !== tabId);
        // If closing active tab, switch to adjacent
        if (tabId === activeTabId && remaining.length > 0) {
          const newIdx = Math.min(idx, remaining.length - 1);
          setActiveTabId(remaining[newIdx].id);
        }
        // Remove any previews associated with this tab
        setPreviews(prev => {
          const toRemove = prev.filter(p => p.tabId === tabId);
          toRemove.forEach(p => detectedPortsRef.current.delete(p.port));
          return prev.filter(p => p.tabId !== tabId);
        });

        return remaining;
      });
    }, [activeTabId, sendTerminalDetach]);

    // When a tab gets its tmux session, run pending CLI command via tmux send-keys (server-side)
    useEffect(() => {
      for (const tab of tabs) {
        if (tab.tmuxSession && pendingCliCommands.current.has(tab.id)) {
          const command = pendingCliCommands.current.get(tab.id)!;
          pendingCliCommands.current.delete(tab.id);
          // Use server-side API to run command via tmux send-keys (doesn't race with terminal rendering)
          fetch('/api/panel/terminal-exec', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionName: tab.tmuxSession, command }),
          }).catch(() => {
            // Fallback: send through WS input after longer delay
            setTimeout(() => {
              sendTerminalInput(tab.tmuxSession!, command + '\n');
            }, 2000);
          });
        }
      }
    }, [tabs, sendTerminalInput]);

    // Drag resize state
    const [previewHeight, setPreviewHeight] = useState(0.55); // 55% default for preview
    const [isDragging, setIsDragging] = useState(false);
    const containerDivRef = useRef<HTMLDivElement>(null);

    const handleDragStart = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);

      const onMove = (ev: MouseEvent) => {
        if (!containerDivRef.current) return;
        const rect = containerDivRef.current.getBoundingClientRect();
        const ratio = (ev.clientY - rect.top) / rect.height;
        setPreviewHeight(Math.min(0.8, Math.max(0.2, ratio)));
      };

      const onUp = () => {
        setIsDragging(false);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }, []);

    const hasPreviews = previews.length > 0;

    return (
      <div ref={containerDivRef} style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: '#ffffff',
      }}>
        {/* Localhost preview pane — slides in when dev servers detected */}
        {hasPreviews && (
          <div style={{
            height: `${previewHeight * 100}%`,
            minHeight: 120,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            flexShrink: 0,
            animation: 'slide-in-preview 300ms ease-out',
            pointerEvents: isDragging ? 'none' : 'auto', // prevent iframe stealing mouse during drag
          }}>
            <PreviewPane
              previews={previews}
              onElementSelect={onPreviewSelection}
              onRefresh={() => {}}
              onClose={(id) => {
                setPreviews(prev => {
                  const removed = prev.find(p => p.id === id);
                  if (removed) detectedPortsRef.current.delete(removed.port);
                  return prev.filter(p => p.id !== id);
                });
              }}
            />
          </div>
        )}

        {/* Drag handle between preview and terminal */}
        {hasPreviews && (
          <div
            onMouseDown={handleDragStart}
            style={{
              height: 8,
              cursor: 'row-resize',
              background: isDragging ? '#93c5fd' : '#e2e8f0',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 20,
              position: 'relative',
            }}
          >
            <div style={{
              width: 32,
              height: 3,
              borderRadius: 2,
              background: isDragging ? '#3b82f6' : '#94a3b8',
            }} />
          </div>
        )}

        {/* Tab bar — stays with the terminal */}
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={setActiveTabId}
          onCloseTab={handleCloseTab}
          onNewTab={handleNewTab}
          onNewChatTab={handleNewChatTab}
          onRegisterRepo={handleRegisterRepo}
        />

        {/* Terminal panels — all mounted, only active is visible */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {tabs.map((tab) => (
            tab.kind === 'chat' ? (
              <div key={tab.id} style={{
                flex: 1,
                display: tab.id === activeTabId ? 'flex' : 'none',
                flexDirection: 'column',
              }}>
                <WorkspaceChatPane
                  tab={tab}
                  onUpdateMessages={(tabId, msgs) => {
                    setTabs(prev => prev.map(t =>
                      t.id === tabId ? { ...t, chatMessages: msgs, lastActivity: Date.now() } : t
                    ));
                  }}
                />
              </div>
            ) : tab.tmuxSession ? (
              <XtermPanel
                key={tab.tmuxSession}
                ref={(handle) => {
                  if (handle) panelRefs.current.set(tab.tmuxSession!, handle);
                  else panelRefs.current.delete(tab.tmuxSession!);
                }}
                tmuxSession={tab.tmuxSession}
                sendTerminalAttach={sendTerminalAttach}
                sendTerminalInput={sendTerminalInput}
                sendTerminalResize={sendTerminalResize}
                sendTerminalDetach={sendTerminalDetach}
                visible={tab.id === activeTabId}
              />
            ) : (
              <div
                key={tab.id}
                style={{
                  flex: 1,
                  display: tab.id === activeTabId ? 'flex' : 'none',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#94a3b8',
                  fontSize: 13,
                  fontFamily: 'ui-monospace, monospace',
                  gap: 8,
                }}
              >
                <TerminalIcon size={14} />
                Starting session…
              </div>
            )
          ))}

          {/* Empty state when no tabs */}
          {tabs.length === 0 && (
            <div style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#94a3b8',
              fontSize: 14,
            }}>
              <TerminalIcon size={18} style={{ marginRight: 8 }} />
              Connecting…
            </div>
          )}
        </div>
      </div>
    );

    // Expose handleSessionCreated for parent to call
    // (handled via useImperativeHandle above for data routing)
  },
);

// TerminalTab is already exported at interface definition above
