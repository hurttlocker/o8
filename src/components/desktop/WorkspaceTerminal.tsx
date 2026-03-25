'use client';
/* eslint-disable @next/next/no-img-element -- terminal image previews intentionally use raw panel-served URLs */

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Plus, X, Terminal as TerminalIcon, ChevronDown, ChevronRight, Crosshair, MessageSquare, Radio, ArrowUp, ArrowDown, Square, AlertCircle } from 'lucide-react';
import LLMChat, { ChainOfThought, MessageBubble, type LLMMessage } from './LLMChat';
import { IssueLinkPickerModal, buildLinkedIssueContext, type LinkedIssueRef } from './IssueLinkPicker';
import { saveTabState, loadTabState, checkAliveSessions, type PersistedTabState } from '@/lib/terminal/tab-state';
import type { MobileTranscriptEntry, MobileTranscriptSource, MobileTranscriptThinkingStep, MobileTranscriptToolCall } from '@/lib/mobile/types';
import {
  type DetectedLocalhostPreview,
  PREVIEW_HOST_MESSAGE_SOURCE,
  PREVIEW_MESSAGE_SOURCE,
  type PreviewSelectionPayload,
} from '@/lib/panel/preview';

/* ── Types ── */

export interface TerminalTab {
  id: string;
  label: string;
  kind: 'terminal' | 'chat' | 'llm-chat';
  tmuxSession: string | null; // null = pending creation (terminal only)
  cliAgent?: string; // which CLI agent was launched (or 'shell')
  repo?: RegisteredRepo; // optional repo context
  createdAt: number; // timestamp for elapsed time
  lastActivity: number; // timestamp of last terminal output
  // Chat-specific fields
  chatRuntime?: 'codex' | 'claude-code' | 'openclaw';
  chatSessionKey?: string; // OpenClaw session key or CLI session ID
  chatModel?: string;
  chatDraftInjection?: { id: string; text: string; autoSend?: boolean };
  chatMessages?: MobileTranscriptEntry[];
  linkedIssue?: LinkedIssueRef | null;
}

type LocalhostPreview = DetectedLocalhostPreview;

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
  onSessionCreated: (sessionName: string, requestId?: string) => boolean;
  clearDetectedPreview: (port: number) => void;
  openCliChatSession: (options: {
    runtime?: 'codex' | 'claude-code';
    repo?: RegisteredRepo;
    modelId?: string;
    initialText?: string;
    autoSend?: boolean;
    createNew?: boolean;
    label?: string;
  }) => string;
  injectIntoCliChat: (text: string, options?: {
    runtime?: 'codex' | 'claude-code';
    repo?: RegisteredRepo;
    modelId?: string;
    autoSend?: boolean;
    createNew?: boolean;
    label?: string;
  }) => string;
}

interface WorkspaceTerminalProps {
  stateScope: string;
  defaultTab: 'llm-chat' | 'terminal';
  sendTerminalCreate: (cols: number, rows: number, requestId?: string) => void;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach: (sessionName: string) => void;
  termWsConnected: boolean;
  onPreviewDetected?: (preview: DetectedLocalhostPreview) => void;
  onPreviewSelection?: (selection: PreviewSelectionPayload) => void;
  showPreviewPane?: boolean;
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

interface WorkspaceCliModelOption {
  id: string;
  label: string;
  color: string;
}

const CLAUDE_CLI_MODELS: WorkspaceCliModelOption[] = [
  { id: 'claude-opus-4-6', label: 'Opus 4.6', color: '#8b5cf6' },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', color: '#8b5cf6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', color: '#8b5cf6' },
];

const CODEX_CLI_MODELS: WorkspaceCliModelOption[] = [
  { id: 'gpt-5.4', label: 'GPT-5.4', color: '#10b981' },
  { id: 'gpt-4o', label: 'GPT-4o', color: '#10b981' },
];

const CLI_SUGGESTED_PROMPTS = [
  { icon: '💡', text: 'Summarize the current repo state', description: 'Quickly orient this CLI session to the local checkout' },
  { icon: '🔍', text: 'Find the files related to the current bug', description: 'Search the repo and point me to the likely change surface' },
  { icon: '🧪', text: 'Tell me what tests I should run next', description: 'Use the current branch and recent changes as context' },
  { icon: '📝', text: 'Explain what changed on this branch', description: 'Read the local diff and summarize the work in progress' },
];

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

function WorkspaceCliModelPicker({
  selected,
  models,
  disabled,
  onSelect,
}: {
  selected: WorkspaceCliModelOption;
  models: WorkspaceCliModelOption[];
  disabled: boolean;
  onSelect: (modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const [dropPos, setDropPos] = useState({ bottom: 0, right: 0 });

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (dropRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setDropPos({
      bottom: window.innerHeight - rect.top + 6,
      right: window.innerWidth - rect.right,
    });
  }, [open]);

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          paddingTop: 6,
          paddingBottom: 6,
          paddingLeft: 10,
          paddingRight: 10,
          borderRadius: 999,
          background: '#ffffff',
          border: '1px solid #e2e8f0',
          fontSize: 12,
          fontWeight: 600,
          color: '#475569',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: selected.color }} />
        {selected.label}
        <ChevronDown size={11} style={{ color: '#94a3b8', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms ease' }} />
      </button>

      {open && (
        <div
          ref={dropRef}
          style={{
            position: 'fixed',
            bottom: dropPos.bottom,
            right: dropPos.right,
            zIndex: 9999,
            minWidth: 220,
            background: 'white',
            border: '1px solid #e2e8f0',
            borderRadius: 12,
            overflow: 'hidden',
            boxShadow: '0 -8px 40px rgba(0, 0, 0, 0.12)',
          }}
        >
          {models.map((model) => (
            <button
              key={model.id}
              type="button"
              onClick={() => { onSelect(model.id); setOpen(false); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                paddingTop: 8,
                paddingBottom: 8,
                paddingLeft: 12,
                paddingRight: 12,
                border: 'none',
                background: model.id === selected.id ? '#f8fafc' : 'transparent',
                color: '#1e293b',
                fontSize: 13,
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#f1f5f9'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = model.id === selected.id ? '#f8fafc' : 'transparent'; }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: model.color, flexShrink: 0 }} />
              <span style={{ fontWeight: 500 }}>{model.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
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

function workspaceToolLabel(toolName: string, args?: Record<string, unknown>) {
  if (toolName === 'search_web') return `Searching "${String(args?.query ?? '')}"`;
  if (toolName === 'read_file' || toolName === 'Read') {
    return `Reading ${String(args?.path ?? args?.file_path ?? '').split('/').pop() || 'file'}`;
  }
  if (toolName === 'search_code' || toolName === 'Grep') return `Searching code for "${String(args?.query ?? args?.pattern ?? '')}"`;
  if (toolName === 'list_files' || toolName === 'Glob') return `Listing ${String(args?.path ?? args?.pattern ?? '.')}`;
  if (toolName === 'create_github_issue') return 'Creating GitHub issue';
  if (toolName === 'read_github_issue_or_pr') return `Reading #${String(args?.number ?? '')}`;
  if (toolName === 'create_pull_request') return 'Creating pull request';
  if (toolName === 'Bash') return `Running ${String(args?.description ?? 'shell command')}`;
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') return `Editing ${String(args?.file_path ?? args?.path ?? 'files')}`;
  if (toolName === 'Task') return `Running task ${String(args?.description ?? '')}`.trim();
  if (toolName === 'WebFetch') return `Fetching ${String(args?.url ?? 'web page')}`;
  if (toolName === 'WebSearch') return `Searching "${String(args?.query ?? '')}"`;
  if (toolName === 'Skill') return `Using skill ${String(args?.skill ?? '')}`.trim();
  return `Running ${toolName}`;
}

function buildWorkspaceThinkingStep(tool: MobileTranscriptToolCall): MobileTranscriptThinkingStep {
  const toolName = tool.name;
  return {
    type: toolName === 'search_web' || toolName === 'search_code' || toolName === 'WebSearch'
      ? 'search'
      : toolName === 'read_file' || toolName === 'list_files' || toolName === 'Read' || toolName === 'Glob'
        ? 'reading'
        : toolName === 'Bash'
          ? 'analyzing'
          : 'tool',
    label: workspaceToolLabel(toolName, tool.args),
    status: tool.status === 'done' ? 'complete' : tool.status === 'calling' ? 'pending' : 'active',
    detail: typeof tool.preview === 'string' ? tool.preview : undefined,
  };
}

function upsertWorkspaceToolCall(
  previous: MobileTranscriptToolCall[],
  next: MobileTranscriptToolCall,
): MobileTranscriptToolCall[] {
  const existingIndex = previous.findIndex((tool) => tool.name === next.name);
  if (existingIndex >= 0) {
    return previous.map((tool, index) => (index === existingIndex ? { ...tool, ...next, status: next.status ?? tool.status } : tool));
  }
  return [...previous, next];
}

function transcriptToolSignature(entry: MobileTranscriptEntry) {
  return (entry.toolCalls ?? [])
    .map((tool) => `${tool.name}:${JSON.stringify(tool.args ?? {})}`)
    .join('|');
}

function mergeTranscriptEntries(current: MobileTranscriptEntry[], incoming: MobileTranscriptEntry[]) {
  const unusedCurrent = [...current];
  const mergedIncoming = incoming.map((entry) => {
    const incomingTools = transcriptToolSignature(entry);
    const matchIndex = unusedCurrent.findIndex((candidate) => (
      candidate.role === entry.role
      && candidate.text.trim() === entry.text.trim()
      && transcriptToolSignature(candidate) === incomingTools
    ));
    if (matchIndex < 0) return entry;
    const [matched] = unusedCurrent.splice(matchIndex, 1);
    return {
      ...entry,
      model: entry.model ?? matched.model,
      tokens: entry.tokens ?? matched.tokens,
      costUsd: entry.costUsd ?? matched.costUsd,
      sources: entry.sources ?? matched.sources,
      thinking: entry.thinking ?? matched.thinking,
      thinkingSteps: entry.thinkingSteps ?? matched.thinkingSteps,
      thinkingDurationMs: entry.thinkingDurationMs ?? matched.thinkingDurationMs,
      recalledFacts: entry.recalledFacts ?? matched.recalledFacts,
      toolCalls: entry.toolCalls ?? matched.toolCalls,
    };
  });
  const latestIncomingTs = mergedIncoming.reduce((max, entry) => Math.max(max, entry.timestamp ?? 0), 0);
  const trailingLocal = unusedCurrent
    .filter((entry) => {
      const ts = entry.timestamp ?? 0;
      if (entry.id.startsWith('msg-')) return true;
      if (entry.id.startsWith('stream:')) return true;
      return latestIncomingTs > 0 && ts >= latestIncomingTs;
    })
    .filter((entry) => !mergedIncoming.some((candidate) => (
      candidate.role === entry.role
      && candidate.text.trim() === entry.text.trim()
      && transcriptToolSignature(candidate) === transcriptToolSignature(entry)
    )))
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return [...mergedIncoming, ...trailingLocal];
}

const WorkspaceChatPane = memo(function WorkspaceChatPane({
  tab,
  onUpdateMessages,
  onUpdateSessionKey,
  onRunInTerminal,
  onSelectModel,
  onConsumeDraftInjection,
  onLinkedIssueChange,
}: {
  tab: TerminalTab;
  onUpdateMessages: (tabId: string, messages: MobileTranscriptEntry[]) => void;
  onUpdateSessionKey: (tabId: string, sessionKey: string) => void;
  onRunInTerminal?: (command: string) => void;
  onSelectModel: (tabId: string, modelId: string) => void;
  onConsumeDraftInjection: (tabId: string, injectionId: string) => void;
  onLinkedIssueChange: (tabId: string, issue: LinkedIssueRef | null) => void;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [liveAssistantId, setLiveAssistantId] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [activeToolCalls, setActiveToolCalls] = useState<MobileTranscriptToolCall[]>([]);
  const [activeThinking, setActiveThinking] = useState<{ steps: MobileTranscriptThinkingStep[]; thinking: string } | null>(null);
  const [streamMeta, setStreamMeta] = useState<{
    tokens?: { input: number; output: number };
    costUsd?: number;
    sources?: MobileTranscriptSource[];
    recalledFacts?: number;
    thinkingDurationMs?: number;
  }>({});
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [issuePickerOpen, setIssuePickerOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const liveToolCallsRef = useRef<MobileTranscriptToolCall[]>([]);
  const messagesRef = useRef<MobileTranscriptEntry[]>([]);
  const stickToBottomRef = useRef(true);
  const handledDraftInjectionRef = useRef<string | null>(null);
  const messages = useMemo(() => tab.chatMessages ?? [], [tab.chatMessages]);
  const tabId = tab.id;
  const chatRuntime = tab.chatRuntime;
  const chatSessionKey = tab.chatSessionKey;
  const chatModel = tab.chatModel;
  const linkedIssue = tab.linkedIssue ?? null;
  const runtimeLabels = useMemo(
    () => ({ 'codex': 'Codex', 'claude-code': 'Claude Code', 'openclaw': 'OpenClaw' } as const),
    [],
  );
  const availableModels = useMemo(
    () => chatRuntime === 'claude-code' ? CLAUDE_CLI_MODELS : CODEX_CLI_MODELS,
    [chatRuntime],
  );
  const selectedModel = useMemo(
    () => availableModels.find((model) => model.id === chatModel) ?? availableModels[0],
    [availableModels, chatModel],
  );

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const scrollToBottom = useCallback((force = false) => {
    if (!scrollRef.current) return;
    if (!force && !stickToBottomRef.current) return;
    setShowScrollToBottom(false);
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, []);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distFromBottom < 80;
    setShowScrollToBottom(distFromBottom >= 80);
  }, []);

  const fetchTranscript = useCallback(async () => {
    if (!chatRuntime || !chatSessionKey) return;
    if (chatRuntime !== 'codex' && chatRuntime !== 'claude-code') return;
    try {
      const prefixedKey = chatRuntime === 'codex'
        ? `codex:${chatSessionKey}`
        : `claude-code:${chatSessionKey}`;
      const endpoint = chatRuntime === 'codex'
        ? `/api/codex/transcript?sessionKey=${encodeURIComponent(prefixedKey)}&limit=80`
        : `/api/claude-code/transcript?sessionKey=${encodeURIComponent(prefixedKey)}&limit=80`;
      const res = await fetch(endpoint);
      if (!res.ok) return;
      const data = await res.json() as { transcript?: MobileTranscriptEntry[] };
      if (Array.isArray(data.transcript)) {
        onUpdateMessages(tabId, mergeTranscriptEntries(messagesRef.current, data.transcript));
        requestAnimationFrame(() => scrollToBottom(true));
      }
    } catch {
      // silent
    }
  }, [chatRuntime, chatSessionKey, onUpdateMessages, scrollToBottom, tabId]);

  useEffect(() => {
    void fetchTranscript();
  }, [fetchTranscript]);

  useEffect(() => {
    if (!chatSessionKey) return;
    const id = setInterval(() => { void fetchTranscript(); }, 30_000);
    return () => clearInterval(id);
  }, [chatSessionKey, fetchTranscript]);

  const sendText = useCallback(async (inputText: string, options?: { baseMessages?: MobileTranscriptEntry[] }) => {
    const text = inputText.trim();
    if (!text || sending) return;
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    setSending(true);
    setAgentRunning(true);
    setStreamingText('');
    liveToolCallsRef.current = [];
    setActiveToolCalls([]);
    setActiveThinking({
      steps: [{
        type: 'thinking',
        label: 'Reasoning through the problem...',
        status: 'active',
      }],
      thinking: '',
    });
    setStreamMeta({});

    const userMsg: MobileTranscriptEntry = {
      id: `msg-${Date.now()}-user`,
      role: 'user',
      text,
      timestamp: Date.now(),
      timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    const baseMessages = options?.baseMessages ?? messagesRef.current;
    const updated = [...baseMessages, userMsg];
    onUpdateMessages(tabId, updated);
    scrollToBottom(true);

    try {
      let endpoint = '';
      let body: Record<string, unknown> = {};

      if (chatRuntime === 'claude-code') {
        endpoint = '/api/claude-code/send';
        body = {
          message: [buildLinkedIssueContext(linkedIssue), text].filter(Boolean).join('\n\n'),
          sessionId: chatSessionKey,
          cwd: tab.repo?.localPath,
          model: selectedModel?.id,
        };
      } else if (chatRuntime === 'codex') {
        endpoint = '/api/codex/send';
        body = {
          message: [buildLinkedIssueContext(linkedIssue), text].filter(Boolean).join('\n\n'),
          threadId: chatSessionKey,
          cwd: tab.repo?.localPath,
          model: selectedModel?.id,
        };
      } else {
        throw new Error('OpenClaw workspace sessions are no longer supported here.');
      }

      const assistantId = `msg-${Date.now()}-assistant`;
      let nextTranscript: MobileTranscriptEntry[] = [
        ...updated,
        {
          id: assistantId,
          role: 'assistant',
          text: '',
          timestamp: Date.now(),
          timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          toolCalls: [],
        },
      ];
      setLiveAssistantId(assistantId);
      onUpdateMessages(tabId, nextTranscript);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => res.statusText);
        onUpdateMessages(
          tabId,
          nextTranscript.map((entry) => entry.id === assistantId ? { ...entry, text: `Error: ${errText || res.statusText}` } : entry),
        );
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      let buffer = '';
      let thinkingText = '';
      const thinkingSteps: MobileTranscriptThinkingStep[] = [{
        type: 'thinking',
        label: 'Reasoning through the problem...',
        status: 'active',
      }];
      const thinkingStartTime = Date.now();
      let isThinking = true;
      let tokens: { input: number; output: number } | undefined;
      let costUsd: number | undefined;
      let recalledFacts = 0;
      const sources: MobileTranscriptSource[] = [];

      const pushThinkingState = (forceLive = false) => {
        if (thinkingSteps.length === 0 && !thinkingText) {
          setActiveThinking(null);
          return;
        }
        const steps = thinkingSteps.map((step) => ({ ...step }));
        setActiveThinking({
          steps: forceLive ? steps : steps.map((step) => ({ ...step, status: step.status === 'active' ? 'complete' : step.status })),
          thinking: thinkingText,
        });
      };

      const updateAssistantEntry = () => {
        const thinkingDurationMs = (thinkingSteps.length > 0 || thinkingText)
          ? Date.now() - thinkingStartTime
          : undefined;
        const uniqueSources = sources.filter((source, index, current) => current.findIndex((candidate) => (
          candidate.title === source.title && candidate.url === source.url && candidate.path === source.path
        )) === index);
        setStreamMeta({
          tokens,
          costUsd,
          sources: uniqueSources.length > 0 ? uniqueSources : undefined,
          recalledFacts: recalledFacts > 0 ? recalledFacts : undefined,
          thinkingDurationMs,
        });
        nextTranscript = nextTranscript.map((entry) => (
          entry.id === assistantId
            ? {
                ...entry,
                text: accumulated,
                model: selectedModel.label,
                tokens,
                costUsd,
                sources: uniqueSources.length > 0 ? uniqueSources : undefined,
                recalledFacts: recalledFacts > 0 ? recalledFacts : undefined,
                toolCalls: liveToolCallsRef.current.length > 0 ? [...liveToolCallsRef.current] : undefined,
                thinking: thinkingText || undefined,
                thinkingSteps: thinkingSteps.length > 0 ? thinkingSteps.map((step) => ({ ...step, status: step.status === 'active' ? 'complete' : step.status })) : undefined,
                thinkingDurationMs,
              }
            : entry
        ));
        onUpdateMessages(tabId, nextTranscript);
      };

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
              status?: 'calling' | 'running' | 'done';
              args?: Record<string, unknown>;
              preview?: string;
              sessionId?: string;
              threadId?: string;
              inputTokens?: number;
              outputTokens?: number;
              costUsd?: number;
              factCount?: number;
              sources?: MobileTranscriptSource[];
            };

            if ((event.type === 'delta' || event.type === 'content') && event.text) {
              if (isThinking) {
                isThinking = false;
                thinkingSteps.forEach((step) => {
                  if (step.status === 'active') step.status = 'complete';
                });
                pushThinkingState(true);
              }
              accumulated += event.text;
              setStreamingText(accumulated);
              updateAssistantEntry();
              scrollToBottom(false);
            }

            if (event.type === 'thinking') {
              if (!isThinking) {
                isThinking = true;
                thinkingSteps.push({
                  type: 'thinking',
                  label: 'Reasoning through the problem...',
                  status: 'active',
                });
              }
              if (event.text) {
                thinkingText += event.text;
                const lines = event.text.split('\n').filter((candidate) => candidate.trim());
                for (const candidate of lines) {
                  const trimmed = candidate.trim();
                  if (trimmed.length > 10 && (
                    trimmed.startsWith('I need to')
                    || trimmed.startsWith('Let me')
                    || trimmed.startsWith('First,')
                    || trimmed.startsWith('Now')
                    || trimmed.startsWith('The ')
                    || trimmed.startsWith('This ')
                  )) {
                    const active = thinkingSteps.find((step) => step.status === 'active');
                    if (active) {
                      active.label = trimmed.slice(0, 60) + (trimmed.length > 60 ? '...' : '');
                    }
                  }
                }
              }
              pushThinkingState(true);
            }

            if ((event.type === 'tool' || event.type === 'tool_call') && event.name) {
              const nextTool: MobileTranscriptToolCall = {
                name: event.name,
                status: event.status ?? 'running',
                args: event.args,
              };
              const nextTools = upsertWorkspaceToolCall(liveToolCallsRef.current, nextTool);
              liveToolCallsRef.current = nextTools;
              setActiveToolCalls(nextTools);
              const nextStep = buildWorkspaceThinkingStep(nextTool);
              const existingStep = thinkingSteps.find((step) => step.label === nextStep.label);
              if (existingStep) {
                existingStep.status = nextStep.status;
                existingStep.detail = nextStep.detail;
              } else {
                thinkingSteps.push(nextStep);
              }
              pushThinkingState(true);
              updateAssistantEntry();
            }

            if (event.type === 'tool_result') {
              const lastTool = event.name
                ? liveToolCallsRef.current.find((tool) => tool.name === event.name)
                : liveToolCallsRef.current[liveToolCallsRef.current.length - 1];
              if (lastTool) {
                const nextTools = upsertWorkspaceToolCall(liveToolCallsRef.current, {
                  ...lastTool,
                  status: 'done',
                  preview: event.preview ?? lastTool.preview,
                });
                liveToolCallsRef.current = nextTools;
                setActiveToolCalls(nextTools);
              }
              const toolStep = [...thinkingSteps].reverse().find((step) => step.status === 'active' && step.type !== 'thinking');
              if (toolStep) toolStep.status = 'complete';
              pushThinkingState(true);
              updateAssistantEntry();
            }

            if (event.type === 'usage') {
              tokens = typeof event.inputTokens === 'number' || typeof event.outputTokens === 'number'
                ? { input: event.inputTokens ?? 0, output: event.outputTokens ?? 0 }
                : tokens;
              if (typeof event.costUsd === 'number') {
                costUsd = event.costUsd;
              }
              updateAssistantEntry();
            }

            if (event.type === 'memory_recall') {
              recalledFacts = event.factCount ?? 0;
              if (recalledFacts > 0) {
                thinkingSteps.push({
                  type: 'search',
                  label: `Recalled ${recalledFacts} memor${recalledFacts === 1 ? 'y' : 'ies'} from Cortex`,
                  status: 'complete',
                });
                pushThinkingState(true);
                updateAssistantEntry();
              }
            }

            if (event.type === 'sources' && Array.isArray(event.sources)) {
              sources.splice(0, sources.length, ...event.sources);
              updateAssistantEntry();
            }

            if (event.sessionId && chatRuntime === 'claude-code') {
              onUpdateSessionKey(tabId, event.sessionId);
            }
            if (event.threadId && chatRuntime === 'codex') {
              onUpdateSessionKey(tabId, event.threadId);
            }

            if (event.type === 'done' || event.type === 'close') {
              if (typeof event.inputTokens === 'number' || typeof event.outputTokens === 'number') {
                tokens = {
                  input: event.inputTokens ?? tokens?.input ?? 0,
                  output: event.outputTokens ?? tokens?.output ?? 0,
                };
              }
              if (typeof event.costUsd === 'number') {
                costUsd = event.costUsd;
              }
              if (event.text && !accumulated) {
                accumulated = event.text;
                setStreamingText(accumulated);
              }
              const settledTools = liveToolCallsRef.current.map((tool) => ({ ...tool, status: 'done' as const }));
              if (settledTools.length > 0) {
                liveToolCallsRef.current = settledTools;
                setActiveToolCalls(settledTools);
              }
              thinkingSteps.forEach((step) => {
                if (step.status === 'active') step.status = 'complete';
              });
              pushThinkingState(false);
              updateAssistantEntry();
            }

            if (event.type === 'error' && event.text) {
              accumulated += `\n⚠️ ${event.text}`;
              updateAssistantEntry();
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }

      if (!accumulated) {
        onUpdateMessages(
          tabId,
          nextTranscript.map((entry) => entry.id === assistantId ? { ...entry, text: 'No response received' } : entry),
        );
      }
    } catch (err) {
      onUpdateMessages(tabId, [
        ...updated,
        {
          id: `msg-${Date.now()}-error`,
          role: 'assistant',
          text: `Error: ${err instanceof Error ? err.message : 'Failed to send'}`,
          timestamp: Date.now(),
          timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } finally {
      setSending(false);
      setAgentRunning(false);
      setLiveAssistantId(null);
      setStreamingText('');
      setActiveThinking(null);
      setStreamMeta({});
      setTimeout(() => { void fetchTranscript(); }, 400);
    }
  }, [chatRuntime, chatSessionKey, fetchTranscript, linkedIssue, onUpdateMessages, onUpdateSessionKey, scrollToBottom, selectedModel, sending, tab.repo?.localPath, tabId]);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft('');
    await sendText(text);
  }, [draft, sendText, sending]);

  useEffect(() => {
    const injection = tab.chatDraftInjection;
    if (!injection?.id) return;
    if (handledDraftInjectionRef.current === injection.id) return;
    handledDraftInjectionRef.current = injection.id;
    stickToBottomRef.current = true;

    if (injection.autoSend) {
      setDraft('');
      void sendText(injection.text);
      requestAnimationFrame(() => composeRef.current?.focus());
    } else {
      setDraft((prev) => prev.trim()
        ? `${prev.trimEnd()}\n\n${injection.text}\n\n`
        : `${injection.text}\n\n`);
      requestAnimationFrame(() => composeRef.current?.focus());
    }

    onConsumeDraftInjection(tabId, injection.id);
  }, [onConsumeDraftInjection, sendText, tab.chatDraftInjection, tabId]);

  const runtimeLabel = runtimeLabels[tab.chatRuntime ?? 'openclaw'];
  const llmMessages = useMemo<LLMMessage[]>(
    () => messages.map((message) => ({
      id: message.id,
      role: message.role === 'system' || message.role === 'tool' ? 'assistant' : message.role,
      content: message.text,
      model: message.model ?? (message.role === 'assistant' ? selectedModel?.label : undefined),
      timestamp: message.timestamp ?? Date.now(),
      tokens: message.tokens,
      costUsd: message.costUsd,
      toolCalls: message.toolCalls?.map((tool) => ({
        name: tool.name,
        status: tool.status ?? 'done',
        args: tool.args,
        preview: tool.preview,
      })),
      sources: message.sources,
      thinking: message.thinking,
      thinkingSteps: message.thinkingSteps,
      thinkingDurationMs: message.thinkingDurationMs,
      recalledFacts: message.recalledFacts,
      isError: /^error:/i.test(message.text.trim()),
    })),
    [messages, selectedModel],
  );

  const visibleMessages = useMemo(
    () => (agentRunning && liveAssistantId ? llmMessages.filter((message) => message.id !== liveAssistantId) : llmMessages),
    [agentRunning, liveAssistantId, llmMessages],
  );

  useEffect(() => {
    if (!scrollRef.current) return;
    if (visibleMessages.length === 0 && !streamingText && activeToolCalls.length === 0) return;
    scrollToBottom();
  }, [activeToolCalls.length, scrollToBottom, streamingText, visibleMessages.length]);

  const handleRetry = useCallback((messageId: string) => {
    const messageIndex = messagesRef.current.findIndex((entry) => entry.id === messageId);
    if (messageIndex < 0) return;
    const previousMessages = messagesRef.current.slice(0, messageIndex);
    const lastUser = [...previousMessages].reverse().find((entry) => entry.role === 'user');
    if (!lastUser) return;
    const baseMessages = previousMessages.filter((entry) => entry.id !== lastUser.id);
    onUpdateMessages(tabId, baseMessages);
    void sendText(lastUser.text, { baseMessages });
  }, [onUpdateMessages, sendText, tabId]);

  const handleEdit = useCallback((messageId: string, content: string) => {
    const messageIndex = messagesRef.current.findIndex((entry) => entry.id === messageId);
    if (messageIndex < 0) return;
    setDraft(content);
    onUpdateMessages(tabId, messagesRef.current.slice(0, messageIndex));
    requestAnimationFrame(() => composeRef.current?.focus());
  }, [onUpdateMessages, tabId]);

  const handleDelete = useCallback((messageId: string) => {
    const current = messagesRef.current;
    const messageIndex = current.findIndex((entry) => entry.id === messageId);
    if (messageIndex < 0) return;
    const message = current[messageIndex];
    if (!message) return;
    if (message.role === 'user' && current[messageIndex + 1]?.role === 'assistant') {
      onUpdateMessages(tabId, current.filter((_, idx) => idx !== messageIndex && idx !== messageIndex + 1));
      return;
    }
    if (message.role === 'assistant' && messageIndex > 0 && current[messageIndex - 1]?.role === 'user') {
      onUpdateMessages(tabId, current.filter((_, idx) => idx !== messageIndex && idx !== messageIndex - 1));
      return;
    }
    onUpdateMessages(tabId, current.filter((_, idx) => idx !== messageIndex));
  }, [onUpdateMessages, tabId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: '#ffffff', position: 'relative' }}>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: 'auto',
          paddingTop: llmMessages.length === 0 && !agentRunning ? 0 : 24,
          paddingBottom: 24,
          paddingLeft: 24,
          paddingRight: 24,
          background: '#ffffff',
        }}
      >
        {visibleMessages.length === 0 && !agentRunning ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            gap: 32,
            animation: 'llmFadeIn 400ms ease-out',
          }}>
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 8,
            }}>
              <div style={{
                width: 48,
                height: 48,
                borderRadius: 14,
                background: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 4px 16px rgba(59, 130, 246, 0.2)',
              }}>
                <MessageSquare size={24} style={{ color: 'white' }} />
              </div>
              <div style={{
                fontSize: 24,
                fontWeight: 600,
                color: '#0f172a',
                letterSpacing: '-0.02em',
              }}>
                {(() => {
                  const h = new Date().getHours();
                  const greeting = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
                  return `${greeting}. What can I help you build?`;
                })()}
              </div>
              <div style={{
                fontSize: 14,
                color: '#94a3b8',
                textAlign: 'center',
                maxWidth: 420,
                lineHeight: '1.5',
              }}>
                Chat with {selectedModel.label} — scoped to this {runtimeLabel} session{tab.repo ? ` in ${tab.repo.name}` : ''}.
              </div>
            </div>

            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 10,
              maxWidth: 560,
              width: '100%',
            }}>
              {CLI_SUGGESTED_PROMPTS.map((prompt, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    setDraft(prompt.text);
                    setTimeout(() => composeRef.current?.focus(), 50);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    paddingTop: 14,
                    paddingBottom: 14,
                    paddingLeft: 14,
                    paddingRight: 14,
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    borderRadius: 12,
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 150ms ease',
                    animation: `llmFadeIn 400ms ease-out ${100 + i * 50}ms both`,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = '#3b82f6';
                    e.currentTarget.style.background = '#f0f9ff';
                    e.currentTarget.style.transform = 'translateY(-1px)';
                    e.currentTarget.style.boxShadow = '0 2px 8px rgba(59, 130, 246, 0.08)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = '#e2e8f0';
                    e.currentTarget.style.background = '#f8fafc';
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = 'none';
                  }}
                >
                  <span style={{ fontSize: 18, lineHeight: '1', flexShrink: 0 }}>{prompt.icon}</span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: '#1e293b', lineHeight: '1.3' }}>
                      {prompt.text}
                    </span>
                    <span style={{ fontSize: 11, color: '#94a3b8', lineHeight: '1.4' }}>
                      {prompt.description}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 720, marginLeft: 'auto', marginRight: 'auto' }}>
            {visibleMessages.map((message, index) => (
              <MessageBubble
                key={message.id}
                message={message}
                isLast={index === visibleMessages.length - 1 && !sending}
                onRetry={message.role === 'assistant' ? () => handleRetry(message.id) : undefined}
                onEdit={message.role === 'user' ? (content) => handleEdit(message.id, content) : undefined}
                onDelete={() => handleDelete(message.id)}
                onRunInTerminal={onRunInTerminal}
              />
            ))}
            {agentRunning && activeThinking && activeThinking.steps.length > 0 ? (
              <ChainOfThought
                steps={activeThinking.steps}
                thinking={activeThinking.thinking}
                durationMs={streamMeta.thinkingDurationMs}
                isLive
              />
            ) : null}
            {agentRunning ? (
              <MessageBubble
                message={{
                  id: `stream:${tabId}`,
                  role: 'assistant',
                  content: streamingText || 'Thinking…',
                  model: selectedModel.label,
                  timestamp: Date.now(),
                  tokens: streamMeta.tokens,
                  costUsd: streamMeta.costUsd,
                  sources: streamMeta.sources,
                  recalledFacts: streamMeta.recalledFacts,
                  toolCalls: activeToolCalls.map((tool) => ({
                    name: tool.name,
                    status: tool.status ?? 'running',
                    args: tool.args,
                    preview: tool.preview,
                  })),
                }}
                isLast
                onRunInTerminal={onRunInTerminal}
              />
            ) : null}
          </div>
        )}
      </div>

      {showScrollToBottom && (llmMessages.length > 0 || agentRunning) ? (
        <div
          style={{
            position: 'absolute',
            right: 30,
            bottom: 104,
            zIndex: 40,
            animation: 'llmFadeIn 150ms ease-out',
          }}
        >
          <button
            type="button"
            onClick={() => {
              scrollToBottom(true);
              stickToBottomRef.current = true;
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              minHeight: 34,
              padding: '7px 12px',
              borderRadius: 999,
              border: '1px solid rgba(96, 165, 250, 0.22)',
              background: 'linear-gradient(180deg, rgba(239,246,255,0.94), rgba(191,219,254,0.72))',
              color: '#1d4ed8',
              boxShadow: '0 12px 28px rgba(37, 99, 235, 0.16)',
              backdropFilter: 'blur(18px)',
              WebkitBackdropFilter: 'blur(18px)',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 700,
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            <ArrowDown size={13} />
            Bottom messages
          </button>
        </div>
      ) : null}

      <div style={{
        paddingTop: 12,
        paddingBottom: 16,
        paddingLeft: 24,
        paddingRight: 24,
        borderTop: '1px solid #f1f5f9',
        background: '#ffffff',
      }}>
        <div style={{
          maxWidth: 720,
          marginLeft: 'auto',
          marginRight: 'auto',
          border: '1px solid #e2e8f0',
          borderRadius: 18,
          background: '#fafafa',
          transition: 'border-color 200ms, box-shadow 200ms',
          overflow: 'hidden',
        }}>
          <div style={{
            paddingTop: 14,
            paddingBottom: 8,
            paddingLeft: 18,
            paddingRight: 18,
          }}>
            <textarea
              ref={composeRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.currentTarget.value);
                e.currentTarget.style.height = 'auto';
                e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 200)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder={`Message ${runtimeLabel}...`}
              rows={1}
              style={{
                width: '100%',
                border: 'none',
                outline: 'none',
                background: 'transparent',
                color: '#1e293b',
                fontSize: 14,
                fontFamily: '-apple-system, system-ui, sans-serif',
                lineHeight: '1.5',
                resize: 'none',
                minHeight: 24,
                maxHeight: 200,
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: 4,
            paddingBottom: 10,
            paddingLeft: 14,
            paddingRight: 10,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                disabled
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  border: 'none',
                  background: 'transparent',
                  color: '#cbd5e1',
                  cursor: 'default',
                }}
                title="Attachments coming soon"
              >
                <Plus size={16} />
              </button>
              <span style={{
                fontSize: 10,
                color: '#cbd5e1',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}>
                CLI session
              </span>
              <button
                type="button"
                onClick={() => setIssuePickerOpen(true)}
                title={linkedIssue ? `${linkedIssue.title}` : 'Link a GitHub issue to this chat'}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  minHeight: 28,
                  padding: '0 10px',
                  borderRadius: 999,
                  border: linkedIssue ? '1px solid rgba(96, 165, 250, 0.22)' : '1px solid rgba(148, 163, 184, 0.16)',
                  background: linkedIssue
                    ? 'linear-gradient(180deg, rgba(239,246,255,0.94), rgba(191,219,254,0.72))'
                    : 'rgba(255,255,255,0.72)',
                  color: linkedIssue ? '#1d4ed8' : '#64748b',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 700,
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  whiteSpace: 'nowrap',
                }}
              >
                <AlertCircle size={13} />
                {linkedIssue ? `Issue #${linkedIssue.number}` : 'Link issue'}
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <WorkspaceCliModelPicker
                selected={selectedModel}
                models={availableModels}
                disabled={sending}
                onSelect={(modelId) => onSelectModel(tabId, modelId)}
              />
              <span style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: agentRunning ? '#22c55e' : '#d1d5db',
              }} />

              {agentRunning ? (
                <button
                  type="button"
                  disabled
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 32,
                    height: 32,
                    border: 'none',
                    borderRadius: 10,
                    background: '#ef4444',
                    color: '#ffffff',
                    cursor: 'default',
                    flexShrink: 0,
                  }}
                >
                  <Square size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleSend()}
                  disabled={!draft.trim() || sending}
                  title="Send message (Enter)"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 32,
                    height: 32,
                    border: 'none',
                    borderRadius: 10,
                    background: draft.trim() ? '#1e293b' : '#e2e8f0',
                    color: draft.trim() ? '#ffffff' : '#94a3b8',
                    cursor: draft.trim() ? 'pointer' : 'default',
                    flexShrink: 0,
                    transition: 'all 150ms',
                  }}
                >
                  <ArrowUp size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <IssueLinkPickerModal
        open={issuePickerOpen}
        onClose={() => setIssuePickerOpen(false)}
        value={linkedIssue}
        preferredRepo={tab.repo ?? null}
        onSelect={(issue) => onLinkedIssueChange(tabId, issue)}
        onClear={() => onLinkedIssueChange(tabId, null)}
      />
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

function parseWorkspaceTaskLabel(label: string) {
  const issueMatch = label.match(/^Issue #(\d+)/i);
  if (issueMatch?.[1]) {
    return { kind: 'issue' as const, number: issueMatch[1] };
  }
  const prMatch = label.match(/^PR #(\d+)/i);
  if (prMatch?.[1]) {
    return { kind: 'pr' as const, number: prMatch[1] };
  }
  return null;
}

function inferWorkspaceTaskState(tab: TerminalTab) {
  const messages = tab.chatMessages ?? [];
  const latestAssistant = [...messages].reverse().find((entry) => entry.role === 'assistant' || entry.role === 'system');
  const latestText = latestAssistant?.text?.toLowerCase() ?? '';
  const ageMs = Date.now() - tab.lastActivity;

  if ((tab.chatDraftInjection?.autoSend ?? false) && messages.length === 0) {
    return { label: 'Queued', color: '#d97706', background: 'rgba(245, 158, 11, 0.12)' };
  }
  if (latestText && /(blocked|unable|failed|error|not ready|missing|broken)/.test(latestText)) {
    return { label: 'Blocked', color: '#dc2626', background: 'rgba(239, 68, 68, 0.12)' };
  }
  if (latestText && /(ready for review|ready to merge|ready for merge|completed|complete\b|done\b|no file edits)/.test(latestText)) {
    return { label: 'Ready', color: '#2563eb', background: 'rgba(37, 99, 235, 0.12)' };
  }
  if (messages.length > 0 && ageMs < 20_000) {
    return { label: 'Working', color: '#16a34a', background: 'rgba(34, 197, 94, 0.12)' };
  }
  if (messages.length > 0) {
    return { label: 'Waiting', color: '#64748b', background: 'rgba(148, 163, 184, 0.12)' };
  }
  return null;
}

const TabBar = memo(function TabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onNewChatTab,
  onNewLLMChatTab,
  onRegisterRepo,
}: {
  tabs: TerminalTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: (agentId: string, repo?: RegisteredRepo) => void;
  onNewChatTab: (runtime: 'codex' | 'claude-code', repo?: RegisteredRepo) => void;
  onNewLLMChatTab: () => void;
  onRegisterRepo?: (localPath: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerStep, setPickerStep] = useState<'main' | 'terminal' | 'session' | 'repo'>('main');
  const [selectedAgent, setSelectedAgent] = useState<typeof CLI_AGENTS[0] | null>(null);
  const [repos, setRepos] = useState<RegisteredRepo[]>([]);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close picker on outside click
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
        setPickerStep('main');
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
          const taskMeta = parseWorkspaceTaskLabel(tab.label);
          const taskState = taskMeta ? inferWorkspaceTaskState(tab) : null;
          const runtimeTag = tab.kind === 'chat'
            ? (tab.chatRuntime === 'claude-code' ? 'Claude' : 'Codex')
            : null;
          return (
            <button
              type="button"
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                paddingTop: 0,
                paddingRight: 12,
                paddingBottom: 0,
                paddingLeft: 12,
                height: taskMeta ? 40 : '100%',
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
              {tab.kind === 'llm-chat' ? (
                <MessageSquare size={12} style={{ color: '#3b82f6' }} />
              ) : tab.kind === 'chat' ? (
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
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0, gap: taskMeta ? 1 : 0 }}>
                <span style={{
                  maxWidth: 180,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontWeight: taskMeta ? 700 : undefined,
                }}>
                  {tab.label}
                </span>
                {taskMeta ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    {runtimeTag ? (
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '1px 6px',
                        borderRadius: 999,
                        background: runtimeTag === 'Codex' ? 'rgba(16, 185, 129, 0.12)' : 'rgba(139, 92, 246, 0.12)',
                        color: runtimeTag === 'Codex' ? '#047857' : '#7c3aed',
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: '0.01em',
                      }}>
                        {runtimeTag}
                      </span>
                    ) : null}
                    {taskState ? (
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '1px 6px',
                        borderRadius: 999,
                        background: taskState.background,
                        color: taskState.color,
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: '0.01em',
                      }}>
                        {taskState.label}
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </span>
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
            {/* Step 1: Main menu — 3 clear choices */}
            {pickerStep === 'main' && (<>
              {/* New Chat — direct LLM, opens immediately */}
              <button
                type="button"
                onClick={() => {
                  onNewLLMChatTab();
                  setPickerOpen(false);
                  setPickerStep('main');
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  paddingTop: 10,
                  paddingRight: 12,
                  paddingBottom: 10,
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
                  <MessageSquare size={14} style={{ color: '#3b82f6' }} />
                </span>
                <div>
                  <div style={{ fontWeight: 500 }}>New Chat</div>
                  <div style={{ fontSize: 11, color: '#94a3b8' }}>Direct LLM conversation</div>
                </div>
              </button>

              <div style={{ height: 1, background: '#f1f5f9' }} />

              {/* CLI Terminal — cascading submenu */}
              <button
                type="button"
                onClick={() => setPickerStep('terminal')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  paddingTop: 10,
                  paddingRight: 12,
                  paddingBottom: 10,
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
                  <TerminalIcon size={14} style={{ color: '#64748b' }} />
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500 }}>CLI Terminal</div>
                  <div style={{ fontSize: 11, color: '#94a3b8' }}>Shell or agent CLI</div>
                </div>
                <ChevronRight size={12} style={{ color: '#94a3b8' }} />
              </button>

              {/* CLI Session — cascading submenu */}
              <button
                type="button"
                onClick={() => setPickerStep('session')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  paddingTop: 10,
                  paddingRight: 12,
                  paddingBottom: 10,
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
                  <Radio size={14} style={{ color: '#8b5cf6' }} />
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500 }}>CLI Session</div>
                  <div style={{ fontSize: 11, color: '#94a3b8' }}>Agent conversation</div>
                </div>
                <ChevronRight size={12} style={{ color: '#94a3b8' }} />
              </button>
            </>)}

            {/* Step 2a: CLI Terminal submenu */}
            {pickerStep === 'terminal' && (<>
              <button
                type="button"
                onClick={() => setPickerStep('main')}
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
                ← CLI Terminal
              </button>
              {CLI_AGENTS.map((agent) => (
                <button
                  type="button"
                  key={agent.id}
                  onClick={() => {
                    if (agent.id === 'shell') {
                      onNewTab(agent.id);
                      setPickerOpen(false);
                      setPickerStep('main');
                    } else {
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
            </>)}

            {/* Step 2b: CLI Session submenu */}
            {pickerStep === 'session' && (<>
              <button
                type="button"
                onClick={() => setPickerStep('main')}
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
                ← CLI Session
              </button>
              {([
                { id: 'codex' as const, label: 'Codex', color: '#10b981' },
                { id: 'claude-code' as const, label: 'Claude Code', color: '#8b5cf6' },
              ]).map((rt) => (
                <button
                  type="button"
                  key={`session-${rt.id}`}
                  onClick={() => {
                    onNewChatTab(rt.id);
                    setPickerOpen(false);
                    setPickerStep('main');
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
                    <div style={{ fontSize: 11, color: '#94a3b8' }}>Agent conversation</div>
                  </div>
                </button>
              ))}
            </>)}

            {/* Step 2: Pick a repo (or launch without repo) */}
            {pickerStep === 'repo' && selectedAgent && (<>
              <button
                type="button"
                onClick={() => { setPickerStep('terminal'); setSelectedAgent(null); }}
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
                  setPickerStep('terminal');
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
                    setPickerStep('terminal');
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
                    setPickerStep('terminal');
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

export const WorkspaceTerminal = forwardRef<TerminalTabHandle, WorkspaceTerminalProps>(
  function WorkspaceTerminal(
    {
      stateScope,
      defaultTab,
      sendTerminalCreate,
      sendTerminalAttach,
      sendTerminalInput,
      sendTerminalResize,
      sendTerminalDetach,
      termWsConnected,
      onPreviewDetected,
      onPreviewSelection,
      showPreviewPane = true,
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
    const pendingRequestRef = useRef<Map<string, string>>(new Map()); // requestId → tabId
    const restoredRef = useRef(false);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const detectedPortsRef = useRef<Set<number>>(new Set()); // avoid duplicate detections
    const urlDetectionEnabledRef = useRef(false); // suppress during initial replay
    const previousWsConnectedRef = useRef(false);

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
            kind: t.kind,
            cliAgent: t.cliAgent ?? 'shell',
            repoName: t.repo?.name,
            repoPath: t.repo?.localPath,
            tmuxSession: t.tmuxSession ?? undefined,
            chatRuntime: t.chatRuntime,
            chatSessionKey: t.chatSessionKey,
            chatModel: t.chatModel,
            linkedIssue: t.linkedIssue ?? undefined,
          })),
          savedAt: new Date().toISOString(),
        };
        saveTabState(persisted, stateScope);
      }, 500);
    }, [stateScope]);

    const requestTerminalForTab = useCallback((tabId: string, command?: string) => {
      const requestId = `workspace-${tabId}-${Date.now()}`;
      pendingRequestRef.current.set(requestId, tabId);
      if (command) {
        pendingCliCommands.current.set(tabId, command);
      }
      sendTerminalCreate(120, 30, requestId);
    }, [sendTerminalCreate]);

    // Save whenever tabs or active tab changes
    useEffect(() => {
      tabsRef.current = tabs;
      if (tabs.length > 0) {
        persistTabs(tabs, activeTabId);
      }
    }, [tabs, activeTabId, persistTabs]);

    const createDefaultShellTab = useCallback((): TerminalTab => {
      tabCountRef.current += 1;
      const now = Date.now();
      return {
        id: `tab-${tabCountRef.current}`,
        label: 'Shell',
        kind: 'terminal',
        tmuxSession: null,
        cliAgent: 'shell',
        createdAt: now,
        lastActivity: now,
      };
    }, []);

    const createDefaultChatTab = useCallback((): TerminalTab => {
      tabCountRef.current += 1;
      const now = Date.now();
      return {
        id: `llm-${tabCountRef.current}`,
        label: 'Chat',
        kind: 'llm-chat',
        tmuxSession: null,
        linkedIssue: null,
        createdAt: now,
        lastActivity: now,
      };
    }, []);

    // Restore tabs on first WS connect for this page load.
    useEffect(() => {
      if (!termWsConnected || restoredRef.current) return;
      restoredRef.current = true;

      // Suppress URL detection for 5s to skip replay of old terminal output
      urlDetectionEnabledRef.current = false;
      setTimeout(() => { urlDetectionEnabledRef.current = true; }, 5000);

      (async () => {
        const saved = await loadTabState(stateScope);

        if (saved && saved.tabs.length > 0) {
          // Check which tmux sessions are still alive
          const tmuxNames = saved.tabs.map(t => t.tmuxSession).filter(Boolean) as string[];
          const alive = await checkAliveSessions(tmuxNames);

          const restoredTabs: TerminalTab[] = [];
          let restoredActiveTabId: string | null = null;
          for (const st of saved.tabs) {
            tabCountRef.current += 1;
            const now = Date.now();
            const tabKind = st.kind ?? 'terminal';

            if (tabKind === 'llm-chat') {
              // LLM Chat tab — restore without tmux
              const tabId = `llm-${tabCountRef.current}`;
              restoredTabs.push({
                id: tabId,
                label: st.label,
                kind: 'llm-chat',
                tmuxSession: null,
                repo: st.repoPath ? { name: st.repoName ?? 'repo', localPath: st.repoPath } : undefined,
                linkedIssue: st.linkedIssue ?? null,
                createdAt: now,
                lastActivity: now,
              });
              if (st.id === saved.activeTabId) {
                restoredActiveTabId = tabId;
              }
            } else if (tabKind === 'chat') {
              // CLI Session tab — restore without tmux
              const tabId = `chat-${tabCountRef.current}`;
              restoredTabs.push({
                id: tabId,
                label: st.label,
                kind: 'chat',
                tmuxSession: null,
                chatRuntime: st.chatRuntime,
                chatSessionKey: st.chatSessionKey,
                chatModel: st.chatModel,
                repo: st.repoPath ? { name: st.repoName ?? 'repo', localPath: st.repoPath } : undefined,
                linkedIssue: st.linkedIssue ?? null,
                createdAt: now,
                lastActivity: now,
                chatMessages: [],
              });
              if (st.id === saved.activeTabId) {
                restoredActiveTabId = tabId;
              }
            } else {
              // Terminal tab
              const tabId = `tab-${tabCountRef.current}`;
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
                  tmuxSession: null,
                  cliAgent: 'shell',
                  repo: st.repoPath ? { name: st.repoName ?? 'repo', localPath: st.repoPath } : undefined,
                  createdAt: now,
                  lastActivity: now,
                });
              }
              if (st.id === saved.activeTabId) {
                restoredActiveTabId = tabId;
              }
            }
          }

          if (defaultTab === 'llm-chat') {
            const restoredChat = restoredTabs.find((tab) => tab.kind === 'llm-chat');
            if (restoredChat) {
              setTabs(restoredTabs);
              setActiveTabId(restoredActiveTabId ?? restoredChat.id);
            } else {
              const defaultChat = createDefaultChatTab();
              setTabs([defaultChat, ...restoredTabs]);
              setActiveTabId(defaultChat.id);
            }
          } else {
            setTabs(restoredTabs);
            const restoredTerminal = restoredTabs.find((tab) => tab.kind === 'terminal');
            setActiveTabId(restoredActiveTabId ?? restoredTerminal?.id ?? restoredTabs[0]?.id ?? '');
          }

          // Create new sessions for terminal tabs that need them (not chat/llm-chat)
          const deadTerminalTabs = restoredTabs.filter(t => t.kind === 'terminal' && t.tmuxSession === null);
          for (const deadTab of deadTerminalTabs) {
            const restoreCommand = deadTab.repo?.localPath ? `cd ${deadTab.repo.localPath}` : undefined;
            requestTerminalForTab(deadTab.id, restoreCommand);
          }
        } else {
          if (defaultTab === 'llm-chat') {
            const defaultChat = createDefaultChatTab();
            setTabs([defaultChat]);
            setActiveTabId(defaultChat.id);
          } else {
            const defaultShell = createDefaultShellTab();
            setTabs([defaultShell]);
            setActiveTabId(defaultShell.id);
            requestTerminalForTab(defaultShell.id);
          }
        }
      })();
    }, [createDefaultChatTab, createDefaultShellTab, defaultTab, requestTerminalForTab, sendTerminalAttach, stateScope, termWsConnected]);

    // On reconnect, reattach existing terminal tabs without resetting chat state.
    useEffect(() => {
      const wasConnected = previousWsConnectedRef.current;
      previousWsConnectedRef.current = termWsConnected;
      if (!termWsConnected || !wasConnected || !restoredRef.current) {
        return;
      }
      for (const tab of tabsRef.current) {
        if (tab.kind === 'terminal' && tab.tmuxSession) {
          sendTerminalAttach(tab.tmuxSession, 120, 30);
        }
      }
    }, [sendTerminalAttach, termWsConnected]);

    // Called when WS server confirms a new tmux session was created
    const handleSessionCreated = useCallback((sessionName: string, requestId?: string) => {
      const directTabId = requestId ? pendingRequestRef.current.get(requestId) : undefined;
      if (requestId && !directTabId) {
        return false;
      }
      if (requestId) pendingRequestRef.current.delete(requestId);

      let claimed = false;
      setTabs(prev => {
        const pendingIdx = directTabId
          ? prev.findIndex(t => t.id === directTabId && t.kind === 'terminal' && t.tmuxSession === null)
          : prev.findIndex(t => t.kind === 'terminal' && t.tmuxSession === null);
        if (pendingIdx >= 0) {
          const updated = [...prev];
          const tab = updated[pendingIdx];
          updated[pendingIdx] = { ...tab, tmuxSession: sessionName };
          claimed = true;
          return updated;
        }
        return prev;
      });
      return claimed;
    }, []);

    const openWorkspaceCliChatSession = useCallback((options: {
      runtime?: 'codex' | 'claude-code';
      repo?: RegisteredRepo;
      modelId?: string;
      initialText?: string;
      autoSend?: boolean;
      createNew?: boolean;
      label?: string;
    }) => {
      let resolvedTabId = '';
      const runtimeLabels = { codex: 'Codex', 'claude-code': 'Claude Code' } as const;
      const activeTab = tabsRef.current.find((tab) => tab.id === activeTabId);
      const resolvedRuntime = options.runtime
        ?? (activeTab?.kind === 'chat' && (activeTab.chatRuntime === 'codex' || activeTab.chatRuntime === 'claude-code')
          ? activeTab.chatRuntime
          : (options.createNew ? 'codex' : 'claude-code'));

      setTabs((prev) => {
        const activeExisting = prev.find((tab) => (
          tab.id === activeTabId
          && tab.kind === 'chat'
          && tab.chatRuntime === resolvedRuntime
          && (options.repo ? tab.repo?.localPath === options.repo.localPath : true)
        ));

        const matchingExisting = options.createNew
          ? null
          : activeExisting ?? prev.find((tab) => (
              tab.kind === 'chat'
              && tab.chatRuntime === resolvedRuntime
              && (options.repo ? tab.repo?.localPath === options.repo.localPath : true)
            ));

        const injection = options.initialText
          ? {
              id: `workspace-chat-injection-${Date.now()}`,
              text: options.initialText,
              autoSend: options.autoSend,
            }
          : undefined;

        if (matchingExisting) {
          resolvedTabId = matchingExisting.id;
          return prev.map((tab) => (
            tab.id === matchingExisting.id
              ? {
                  ...tab,
                  label: options.label ?? tab.label,
                  chatModel: options.modelId ?? tab.chatModel,
                  chatDraftInjection: injection ?? tab.chatDraftInjection,
                }
              : tab
          ));
        }

        tabCountRef.current += 1;
        resolvedTabId = `chat-${tabCountRef.current}`;
        const now = Date.now();
        const baseLabel = options.repo ? `${runtimeLabels[resolvedRuntime]} · ${options.repo.name}` : runtimeLabels[resolvedRuntime];
        const newTab: TerminalTab = {
          id: resolvedTabId,
          label: options.label ?? baseLabel,
          kind: 'chat',
          tmuxSession: null,
          chatRuntime: resolvedRuntime,
          chatSessionKey: undefined,
          chatModel: options.modelId ?? (resolvedRuntime === 'claude-code' ? CLAUDE_CLI_MODELS[0].id : CODEX_CLI_MODELS[0].id),
          chatDraftInjection: injection,
          repo: options.repo,
          createdAt: now,
          lastActivity: now,
          chatMessages: [],
        };
        return [...prev, newTab];
      });

      if (resolvedTabId) {
        setActiveTabId(resolvedTabId);
      }

      return resolvedTabId;
    }, [activeTabId]);

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
            onPreviewDetected?.(newPreview);
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
      clearDetectedPreview: (port: number) => {
        detectedPortsRef.current.delete(port);
        setPreviews((prev) => prev.filter((preview) => preview.port !== port));
      },
      openCliChatSession: (options) => openWorkspaceCliChatSession(options),
      injectIntoCliChat: (text, options) => openWorkspaceCliChatSession({
        runtime: options?.runtime,
        repo: options?.repo,
        modelId: options?.modelId,
        initialText: text,
        autoSend: options?.autoSend ?? false,
        createNew: options?.createNew ?? false,
        label: options?.label,
      }),
    }), [handleSessionCreated, onPreviewDetected, openWorkspaceCliChatSession]);

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
      requestTerminalForTab(tabId, pendingCliCommands.current.get(tabId));
    }, [requestTerminalForTab]);

    const handleNewChatTab = useCallback((runtime: 'codex' | 'claude-code', repo?: RegisteredRepo) => {
      tabCountRef.current += 1;
      const tabId = `chat-${tabCountRef.current}`;
      const runtimeLabels = { 'codex': 'Codex', 'claude-code': 'Claude Code' };
      const label = repo ? `${runtimeLabels[runtime]} · ${repo.name}` : runtimeLabels[runtime];
      const now = Date.now();
      const newTab: TerminalTab = {
        id: tabId,
        label,
        kind: 'chat',
        tmuxSession: null,
        chatRuntime: runtime,
        chatModel: runtime === 'claude-code' ? CLAUDE_CLI_MODELS[0].id : CODEX_CLI_MODELS[0].id,
        repo,
        linkedIssue: null,
        createdAt: now,
        lastActivity: now,
        chatMessages: [],
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(tabId);
    }, []);

    const handleNewLLMChatTab = useCallback(() => {
      tabCountRef.current += 1;
      const tabId = `llm-${tabCountRef.current}`;
      const now = Date.now();
      const newTab: TerminalTab = {
        id: tabId,
        label: 'Chat',
        kind: 'llm-chat',
        tmuxSession: null,
        linkedIssue: null,
        createdAt: now,
        lastActivity: now,
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(tabId);
    }, []);

    const handleUpdateChatMessages = useCallback((tabId: string, messages: MobileTranscriptEntry[]) => {
      setTabs(prev => prev.map(t =>
        t.id === tabId ? { ...t, chatMessages: messages, lastActivity: Date.now() } : t
      ));
    }, []);

    const handleUpdateChatSessionKey = useCallback((tabId: string, sessionKey: string) => {
      setTabs(prev => prev.map(t =>
        t.id === tabId ? { ...t, chatSessionKey: sessionKey } : t
      ));
    }, []);

    const handleUpdateChatModel = useCallback((tabId: string, modelId: string) => {
      setTabs(prev => prev.map(t =>
        t.id === tabId ? { ...t, chatModel: modelId } : t
      ));
    }, []);

    const handleUpdateLinkedIssue = useCallback((tabId: string, linkedIssue: LinkedIssueRef | null) => {
      setTabs(prev => prev.map(t =>
        t.id === tabId ? { ...t, linkedIssue } : t
      ));
    }, []);

    const handleConsumeChatDraftInjection = useCallback((tabId: string, injectionId: string) => {
      setTabs(prev => prev.map((tab) => (
        tab.id === tabId && tab.chatDraftInjection?.id === injectionId
          ? { ...tab, chatDraftInjection: undefined }
          : tab
      )));
    }, []);

    const handleRunCommandInTerminal = useCallback((command: string) => {
      const shellTab = tabs.find(t => t.kind === 'terminal' && t.tmuxSession);
      if (shellTab?.tmuxSession) {
        sendTerminalInput(shellTab.tmuxSession, command + '\n');
        return;
      }

      const pendingShell = tabs.find(t => t.kind === 'terminal' && !t.tmuxSession);
      if (pendingShell) {
        pendingCliCommands.current.set(pendingShell.id, command);
        setActiveTabId(pendingShell.id);
        return;
      }

      tabCountRef.current += 1;
      const nextTabId = `tab-${tabCountRef.current}`;
      const now = Date.now();
      const newTab: TerminalTab = {
        id: nextTabId,
        label: 'Terminal',
        kind: 'terminal',
        tmuxSession: null,
        cliAgent: 'shell',
        createdAt: now,
        lastActivity: now,
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(nextTabId);
      requestTerminalForTab(nextTabId, command);
    }, [requestTerminalForTab, sendTerminalInput, tabs]);

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
        pendingCliCommands.current.delete(tabId);
        for (const [requestId, pendingTabId] of pendingRequestRef.current) {
          if (pendingTabId === tabId) pendingRequestRef.current.delete(requestId);
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

    const hasPreviews = showPreviewPane && previews.length > 0;

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
          onNewLLMChatTab={handleNewLLMChatTab}
          onRegisterRepo={handleRegisterRepo}
        />

        {/* Terminal panels — all mounted, only active is visible */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {tabs.map((tab) => (
            tab.kind === 'llm-chat' ? (
              <div key={tab.id} style={{
                flex: 1,
                display: tab.id === activeTabId ? 'flex' : 'none',
                flexDirection: 'column',
                height: '100%',
              }}>
                <LLMChat
                  tabId={tab.id}
                  preferredRepo={tab.repo ?? null}
                  linkedIssue={tab.linkedIssue ?? null}
                  onLinkedIssueChange={(issue) => handleUpdateLinkedIssue(tab.id, issue)}
                  onOpenHistoryChat={(historyTabId: string, title: string) => {
                    // Create a new tab that loads the history
                    tabCountRef.current += 1;
                    const now = Date.now();
                    const newTab: TerminalTab = {
                      id: historyTabId,
                      label: title.slice(0, 20) + (title.length > 20 ? '...' : ''),
                      kind: 'llm-chat',
                      tmuxSession: null,
                      repo: tab.repo,
                      linkedIssue: tab.linkedIssue ?? null,
                      createdAt: now,
                      lastActivity: now,
                    };
                    setTabs(prev => {
                      // Don't create duplicate tabs
                      if (prev.some(t => t.id === historyTabId)) {
                        setActiveTabId(historyTabId);
                        return prev;
                      }
                      return [...prev, newTab];
                    });
                    setActiveTabId(historyTabId);
                  }}
                  onRunInTerminal={handleRunCommandInTerminal}
                />
              </div>
            ) : tab.kind === 'chat' ? (
              <div key={tab.id} style={{
                flex: 1,
                display: tab.id === activeTabId ? 'flex' : 'none',
                flexDirection: 'column',
                height: '100%',
                minHeight: 0,
              }}>
                <WorkspaceChatPane
                  tab={tab}
                  onUpdateMessages={handleUpdateChatMessages}
                  onUpdateSessionKey={handleUpdateChatSessionKey}
                  onRunInTerminal={handleRunCommandInTerminal}
                  onSelectModel={handleUpdateChatModel}
                  onConsumeDraftInjection={handleConsumeChatDraftInjection}
                  onLinkedIssueChange={handleUpdateLinkedIssue}
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
