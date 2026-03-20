'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { X, ChevronDown, FileCode, FilePlus, PenLine, Eye, Terminal } from 'lucide-react';
import { useSharedDesktopWs } from './hooks/DesktopWebSocketContext';
import type { DesktopWsCallbacks } from './hooks/useDesktopWebSocket';

/* ── Terminal Handle (ref-based API for parent → terminal communication) ── */
export interface TerminalHandle {
  writeToTerminal: (data: string) => void;
  setTermError: (error: string) => void;
  setTermExited: (exited: boolean) => void;
}

/* ── Types ── */
interface DiffEntry {
  id: string;
  file: string;
  shortFile: string;
  tool: 'Edit' | 'Write' | 'Read' | 'MultiEdit';
  oldText?: string;
  newText?: string;
  content?: string;
  timestamp: number;
}

interface LiveOutputProps {
  agentName?: string;
  agentRuntime?: string;
  sessionKey?: string;
  onClose?: () => void;
  onCollapseChange?: (collapsed: boolean) => void;
  tmuxSession?: string;
  sendTerminalAttach?: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput?: (sessionName: string, data: string) => void;
  sendTerminalResize?: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach?: (sessionName: string) => void;
  onTerminalData?: (sessionName: string, data: string) => void;
  onTerminalAttached?: (sessionName: string) => void;
  onTerminalExited?: (sessionName: string, exitCode: number) => void;
  onTerminalError?: (sessionName: string, error: string) => void;
  terminalRef?: React.Ref<TerminalHandle>;
}

/* ── Diff line computation ── */
function computeDiffLines(oldText: string, newText: string): { type: 'same' | 'add' | 'del'; text: string }[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: { type: 'same' | 'add' | 'del'; text: string }[] = [];

  // Find common prefix
  let prefixLen = 0;
  while (prefixLen < Math.min(oldLines.length, newLines.length) && oldLines[prefixLen] === newLines[prefixLen]) {
    result.push({ type: 'same', text: oldLines[prefixLen] });
    prefixLen++;
  }

  // Find common suffix
  let suffixLen = 0;
  while (
    suffixLen < Math.min(oldLines.length - prefixLen, newLines.length - prefixLen) &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  // Middle section: deletions then additions
  const oldMiddle = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const newMiddle = newLines.slice(prefixLen, newLines.length - suffixLen);

  for (const line of oldMiddle) result.push({ type: 'del', text: line });
  for (const line of newMiddle) result.push({ type: 'add', text: line });

  // Common suffix
  for (let i = oldLines.length - suffixLen; i < oldLines.length; i++) {
    result.push({ type: 'same', text: oldLines[i] });
  }

  return result;
}

/* ── Single Diff Card ── */
function DiffCard({ diff, isLatest }: { diff: DiffEntry; isLatest: boolean }) {
  const [expanded, setExpanded] = useState(isLatest);
  const isEdit = diff.tool === 'Edit' || diff.tool === 'MultiEdit';
  const isWrite = diff.tool === 'Write';
  const hasContent = isEdit ? (diff.oldText && diff.newText) : isWrite ? diff.content : false;

  const lines = isEdit && diff.oldText && diff.newText
    ? computeDiffLines(diff.oldText, diff.newText)
    : [];

  const additions = lines.filter(l => l.type === 'add').length;
  const deletions = lines.filter(l => l.type === 'del').length;

  const age = Math.round((Date.now() - diff.timestamp) / 1000);
  const ageLabel = age < 60 ? `${age}s ago` : age < 3600 ? `${Math.round(age / 60)}m ago` : `${Math.round(age / 3600)}h ago`;

  return (
    <div style={{
      borderRadius: 10,
      overflow: 'hidden',
      border: isLatest
        ? '1px solid rgba(147, 197, 253, 0.15)'
        : '1px solid rgba(147, 197, 253, 0.06)',
      background: isLatest
        ? 'rgba(147, 197, 253, 0.04)'
        : 'rgba(255, 255, 255, 0.015)',
      animation: isLatest ? 'diffCardSlideIn 400ms cubic-bezier(0.32, 0.72, 0, 1)' : 'none',
      transition: 'border-color 200ms ease',
    }}>
      {/* File header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          paddingTop: 8,
          paddingRight: 12,
          paddingBottom: 8,
          paddingLeft: 12,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        {isEdit ? <PenLine size={13} color="rgba(147, 197, 253, 0.7)" /> :
         isWrite ? <FilePlus size={13} color="rgba(52, 211, 153, 0.7)" /> :
         <Eye size={13} color="rgba(148, 163, 184, 0.5)" />}

        <span style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'rgba(226, 232, 240, 0.9)',
          fontFamily: 'ui-monospace, "SF Mono", Monaco, monospace',
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {diff.shortFile}
        </span>

        {/* Stats pills */}
        {isEdit && (additions > 0 || deletions > 0) && (
          <span style={{
            display: 'flex',
            gap: 4,
            fontSize: 10,
            fontWeight: 600,
            fontFamily: 'ui-monospace, "SF Mono", Monaco, monospace',
          }}>
            {additions > 0 && <span style={{ color: '#34d399' }}>+{additions}</span>}
            {deletions > 0 && <span style={{ color: '#93c5fd' }}>-{deletions}</span>}
          </span>
        )}
        {isWrite && <span style={{ fontSize: 10, color: 'rgba(52, 211, 153, 0.6)', fontWeight: 500 }}>new</span>}

        <span style={{
          fontSize: 9,
          color: 'rgba(148, 163, 184, 0.35)',
          flexShrink: 0,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {ageLabel}
        </span>

        <ChevronDown
          size={12}
          color="rgba(148, 163, 184, 0.3)"
          style={{
            transition: 'transform 200ms ease',
            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
            flexShrink: 0,
          }}
        />
      </button>

      {/* Expanded diff content */}
      {expanded && hasContent && (
        <div style={{
          borderTop: '1px solid rgba(147, 197, 253, 0.06)',
          maxHeight: 260,
          overflow: 'auto',
        }}>
          {isEdit && lines.length > 0 && (
            <div style={{
              fontFamily: 'ui-monospace, "SF Mono", Monaco, monospace',
              fontSize: 11,
              lineHeight: 1.7,
            }}>
              {lines.filter(l => l.type !== 'same').map((line, i) => (
                <div
                  key={i}
                  style={{
                    paddingTop: 0,
                    paddingRight: 12,
                    paddingBottom: 0,
                    paddingLeft: 12,
                    background: line.type === 'add'
                      ? 'rgba(52, 211, 153, 0.06)'
                      : line.type === 'del'
                        ? 'rgba(147, 197, 253, 0.04)'
                        : 'transparent',
                    color: line.type === 'add'
                      ? 'rgba(52, 211, 153, 0.85)'
                      : line.type === 'del'
                        ? 'rgba(147, 197, 253, 0.5)'
                        : 'rgba(226, 232, 240, 0.4)',
                    borderLeft: line.type === 'add'
                      ? '2px solid rgba(52, 211, 153, 0.4)'
                      : line.type === 'del'
                        ? '2px solid rgba(147, 197, 253, 0.2)'
                        : '2px solid transparent',
                    whiteSpace: 'pre',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  <span style={{
                    display: 'inline-block',
                    width: 16,
                    textAlign: 'center',
                    color: line.type === 'add'
                      ? 'rgba(52, 211, 153, 0.5)'
                      : 'rgba(147, 197, 253, 0.35)',
                    userSelect: 'none',
                    marginRight: 4,
                  }}>
                    {line.type === 'add' ? '+' : '-'}
                  </span>
                  {line.text}
                </div>
              ))}
            </div>
          )}

          {isWrite && diff.content && (
            <div style={{
              fontFamily: 'ui-monospace, "SF Mono", Monaco, monospace',
              fontSize: 11,
              lineHeight: 1.7,
              paddingTop: 6,
              paddingRight: 12,
              paddingBottom: 6,
              paddingLeft: 12,
              color: 'rgba(52, 211, 153, 0.7)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              maxHeight: 200,
              overflow: 'auto',
            }}>
              {diff.content.slice(0, 600)}{diff.content.length > 600 ? '\n…' : ''}
            </div>
          )}
        </div>
      )}

      {/* File path subtitle */}
      {expanded && (
        <div style={{
          paddingTop: 4,
          paddingRight: 12,
          paddingBottom: 6,
          paddingLeft: 34,
          fontSize: 10,
          color: 'rgba(148, 163, 184, 0.25)',
          fontFamily: 'ui-monospace, "SF Mono", Monaco, monospace',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {diff.file}
        </div>
      )}
    </div>
  );
}

/* ── File summary bar ── */
function FileSummaryBar({ diffs }: { diffs: DiffEntry[] }) {
  const files = new Map<string, { adds: number; dels: number; tool: string }>();
  for (const d of diffs) {
    const existing = files.get(d.shortFile) ?? { adds: 0, dels: 0, tool: d.tool };
    if (d.oldText && d.newText) {
      const lines = computeDiffLines(d.oldText, d.newText);
      existing.adds += lines.filter(l => l.type === 'add').length;
      existing.dels += lines.filter(l => l.type === 'del').length;
    }
    if (d.tool === 'Write') existing.tool = 'Write';
    files.set(d.shortFile, existing);
  }

  return (
    <div style={{
      display: 'flex',
      gap: 6,
      paddingTop: 4,
      paddingRight: 12,
      paddingBottom: 4,
      paddingLeft: 12,
      overflowX: 'auto',
      flexShrink: 0,
    }}>
      {[...files.entries()].map(([name, stats]) => (
        <span
          key={name}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            paddingTop: 2,
            paddingRight: 8,
            paddingBottom: 2,
            paddingLeft: 6,
            borderRadius: 6,
            background: 'rgba(147, 197, 253, 0.06)',
            border: '1px solid rgba(147, 197, 253, 0.08)',
            fontSize: 10,
            fontFamily: 'ui-monospace, "SF Mono", Monaco, monospace',
            color: 'rgba(226, 232, 240, 0.6)',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          <FileCode size={10} color="rgba(147, 197, 253, 0.5)" />
          {name}
          {stats.adds > 0 && <span style={{ color: '#34d399', fontWeight: 600 }}>+{stats.adds}</span>}
          {stats.dels > 0 && <span style={{ color: '#93c5fd', fontWeight: 600 }}>-{stats.dels}</span>}
          {stats.tool === 'Write' && <span style={{ color: 'rgba(52, 211, 153, 0.5)' }}>new</span>}
        </span>
      ))}
    </div>
  );
}

/* ── Inline Terminal (xterm.js) ── */
interface InlineTerminalProps {
  tmuxSession: string;
  sendTerminalAttach?: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput?: (sessionName: string, data: string) => void;
  sendTerminalResize?: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach?: (sessionName: string) => void;
  onTerminalData?: (sessionName: string, data: string) => void;
  onTerminalAttached?: (sessionName: string) => void;
  onTerminalExited?: (sessionName: string, exitCode: number) => void;
  onTerminalError?: (sessionName: string, error: string) => void;
}

const InlineTerminal = forwardRef<TerminalHandle, InlineTerminalProps>(function InlineTerminal({
  tmuxSession,
  sendTerminalAttach,
  sendTerminalInput,
  sendTerminalResize,
  sendTerminalDetach,
  onTerminalData,
  onTerminalAttached,
  onTerminalExited,
  onTerminalError,
}, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const termRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fitAddonRef = useRef<any>(null);
  const attachedRef = useRef(false);
  const [termError, setTermError] = useState<string | null>(null);
  const [termExited, setTermExited] = useState(false);

  // Stable refs for callbacks
  const onTerminalDataRef = useRef(onTerminalData);
  const onTerminalAttachedRef = useRef(onTerminalAttached);
  const onTerminalExitedRef = useRef(onTerminalExited);
  const onTerminalErrorRef = useRef(onTerminalError);
  useEffect(() => { onTerminalDataRef.current = onTerminalData; }, [onTerminalData]);
  useEffect(() => { onTerminalAttachedRef.current = onTerminalAttached; }, [onTerminalAttached]);
  useEffect(() => { onTerminalExitedRef.current = onTerminalExited; }, [onTerminalExited]);
  useEffect(() => { onTerminalErrorRef.current = onTerminalError; }, [onTerminalError]);

  // Initialize xterm.js
  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;

    async function init() {
      try {
        // Dynamic import to avoid SSR issues
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
        ]);

        if (disposed) return;

        // Inject xterm CSS if not already present
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
          lineHeight: 1.3,
          cursorBlink: true,
          allowTransparency: true,
          scrollback: 5000,
          theme: {
            background: 'transparent',
            foreground: '#e2e8f0',
            cursor: '#93c5fd',
            cursorAccent: '#0a0c12',
            selectionBackground: 'rgba(147, 197, 253, 0.25)',
            selectionForeground: '#e2e8f0',
            black: '#1e293b',
            red: '#ef4444',
            green: '#34d399',
            yellow: '#f59e0b',
            blue: '#93c5fd',
            magenta: '#c084fc',
            cyan: '#22d3ee',
            white: '#e2e8f0',
            brightBlack: '#475569',
            brightRed: '#f87171',
            brightGreen: '#6ee7b7',
            brightYellow: '#fbbf24',
            brightBlue: '#bfdbfe',
            brightMagenta: '#d8b4fe',
            brightCyan: '#67e8f9',
            brightWhite: '#f8fafc',
          },
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);

        if (!containerRef.current || disposed) {
          term.dispose();
          return;
        }

        term.open(containerRef.current);
        fitAddon.fit();

        termRef.current = term;
        fitAddonRef.current = fitAddon;

        // Send attach request
        const { cols, rows } = term;
        sendTerminalAttach?.(tmuxSession, cols, rows);

        // Wire input: xterm → WS → tmux
        term.onData((data) => {
          sendTerminalInput?.(tmuxSession, data);
        });

        // ResizeObserver for auto-fit
        const observer = new ResizeObserver(() => {
          if (disposed || !fitAddonRef.current) return;
          try {
            fitAddonRef.current.fit();
            const { cols: c, rows: r } = termRef.current;
            sendTerminalResize?.(tmuxSession, c, r);
          } catch { /* ignore resize errors during transitions */ }
        });
        if (containerRef.current) observer.observe(containerRef.current);

        return () => {
          observer.disconnect();
        };
      } catch (err) {
        if (!disposed) {
          setTermError(err instanceof Error ? err.message : 'Failed to initialize terminal');
        }
      }
    }

    const cleanupPromise = init();

    return () => {
      disposed = true;
      sendTerminalDetach?.(tmuxSession);
      cleanupPromise?.then(cleanup => cleanup?.());
      if (termRef.current) {
        termRef.current.dispose();
        termRef.current = null;
      }
      fitAddonRef.current = null;
      attachedRef.current = false;
    };
  }, [tmuxSession, sendTerminalAttach, sendTerminalInput, sendTerminalResize, sendTerminalDetach]);

  // Expose a method for parent to write data (used via useImperativeHandle above)
  const writeToTerminal = useCallback((data: string) => {
    if (!termRef.current) return;
    try {
      // data is base64 encoded
      const decoded = atob(data);
      termRef.current.write(decoded);
    } catch { /* ignore decode errors */ }
  }, []);

  // Expose terminal methods to parent via React ref (replaces DOM-coupling pattern)
  useImperativeHandle(ref, () => ({
    writeToTerminal,
    setTermError: (error: string) => setTermError(error),
    setTermExited: (exited: boolean) => setTermExited(exited),
  }), [writeToTerminal]);

  if (termError) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: 16,
        gap: 8,
      }}>
        <Terminal size={16} color="rgba(239, 68, 68, 0.5)" />
        <span style={{
          fontSize: 12,
          color: 'rgba(239, 68, 68, 0.6)',
          fontFamily: 'ui-monospace, "SF Mono", Monaco, monospace',
        }}>
          {termError}
        </span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        minHeight: 0,
        padding: 4,
        overflow: 'hidden',
      }}
    />
  );
});

/* ── Main Component ── */
export function LiveOutput({
  agentName,
  agentRuntime,
  sessionKey,
  onClose,
  onCollapseChange,
  tmuxSession,
  sendTerminalAttach,
  sendTerminalInput,
  sendTerminalResize,
  sendTerminalDetach,
  onTerminalData,
  onTerminalAttached,
  onTerminalExited,
  onTerminalError,
  terminalRef,
}: LiveOutputProps) {
  const [diffs, setDiffs] = useState<DiffEntry[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const prevCountRef = useRef(0);
  const termContainerRef = useRef<HTMLDivElement>(null);
  const fetchNowRef = useRef<() => void>(() => {});

  // Standalone terminal mode: tmuxSession provided but no agent session
  const standaloneTerminal = !!tmuxSession && !sessionKey;

  // Split ratio: percentage of space for diff cards (rest goes to terminal)
  const [splitPct, setSplitPct] = useState(tmuxSession ? 35 : 100);
  const splitDragging = useRef(false);

  const fetchDiffs = useCallback(async () => {
    if (!sessionKey) return; // No diffs in standalone terminal mode
    try {
      const isClaudeCode = sessionKey.startsWith('claude-code:');
      const isCodex = sessionKey.startsWith('codex:');

      let url: string;
      if (isClaudeCode) {
        url = '/api/claude-code/diffs?limit=30';
      } else if (isCodex) {
        url = '/api/codex/diffs?limit=30';
      } else {
        const histUrl = `/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=30`;
        const res = await fetch(histUrl);
        if (!res.ok) return;
        const data = await res.json();
        const transcript = data.transcript ?? data.entries ?? [];

        const extracted: DiffEntry[] = [];
        for (const entry of transcript) {
          if (entry.role !== 'assistant') continue;
          const text = entry.text ?? '';
          const fileMatches = text.matchAll(/(?:edit|wrote?|created?|modified?|updated?)\s+[`"*]?([^\s`"*]+\.\w{1,6})[`"*]?/gi);
          for (const match of fileMatches) {
            extracted.push({
              id: `${entry.id}-${match[1]}`,
              file: match[1],
              shortFile: match[1].split('/').pop() ?? match[1],
              tool: 'Edit',
              timestamp: Date.now(),
            });
          }
        }
        if (extracted.length !== prevCountRef.current) {
          setDiffs(extracted);
          prevCountRef.current = extracted.length;
        }
        return;
      }

      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const newDiffs = (data.diffs ?? []) as DiffEntry[];
      if (newDiffs.length !== prevCountRef.current) {
        setDiffs(newDiffs);
        prevCountRef.current = newDiffs.length;
      }
    } catch { /* silent */ }
  }, [sessionKey]);

  const wsCallbacks = useMemo<DesktopWsCallbacks>(() => ({
    onReviewUpdate: (data: Record<string, unknown>) => {
      if (!sessionKey) return;
      const event = data.event as string | undefined;
      if (event !== 'file-changes' && event !== 'diff-stats') return;
      const eventSessionKey = data.sessionKey as string | undefined;
      if (eventSessionKey && eventSessionKey !== sessionKey) return;
      fetchNowRef.current();
    },
  }), [sessionKey]);

  const { isConnected: reviewWsConnected } = useSharedDesktopWs(undefined, wsCallbacks);

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    fetchNowRef.current = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { void fetchDiffs(); }, 150);
    };
    fetchNowRef.current();
    pollRef.current = setInterval(() => { void fetchDiffs(); }, reviewWsConnected ? 15_000 : 4_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [fetchDiffs, reviewWsConnected]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [diffs]);

  // Terminal data flow is now handled via React ref (terminalRef → InlineTerminal)
  // Parent calls terminalRef.current.writeToTerminal() directly — no DOM coupling

  // Handle drag for split resize
  const startSplitDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    splitDragging.current = true;
    const startY = e.clientY;
    const startPct = splitPct;

    const onMove = (ev: MouseEvent) => {
      const parent = (e.target as HTMLElement).parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const totalH = rect.height;
      const deltaY = ev.clientY - startY;
      const deltaPct = (deltaY / totalH) * 100;
      setSplitPct(Math.min(Math.max(startPct + deltaPct, 10), 80));
    };
    const onUp = () => {
      splitDragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [splitPct]);

  const runtimeLabel = standaloneTerminal ? ''
    : agentRuntime === 'claude-code' ? 'Claude Code'
    : agentRuntime === 'codex' ? 'Codex'
    : 'OpenClaw';

  const headerName = standaloneTerminal ? 'Terminal' : (agentName ?? 'Agent');

  const totalAdds = diffs.reduce((sum, d) => {
    if (!d.oldText || !d.newText) return sum;
    return sum + computeDiffLines(d.oldText, d.newText).filter(l => l.type === 'add').length;
  }, 0);
  const totalDels = diffs.reduce((sum, d) => {
    if (!d.oldText || !d.newText) return sum;
    return sum + computeDiffLines(d.oldText, d.newText).filter(l => l.type === 'del').length;
  }, 0);

  const hasTerminal = !!tmuxSession;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      height: '100%',
      background: 'rgba(10, 12, 18, 0.75)',
      backdropFilter: 'blur(32px)',
      WebkitBackdropFilter: 'blur(32px)',
      borderBottom: '1px solid rgba(147, 197, 253, 0.06)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingTop: 8,
        paddingRight: 12,
        paddingBottom: 8,
        paddingLeft: 14,
        flexShrink: 0,
        borderBottom: '1px solid rgba(147, 197, 253, 0.05)',
      }}>
        <span style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          backgroundColor: diffs.length > 0 ? '#34c759' : 'rgba(148, 163, 184, 0.3)',
          boxShadow: diffs.length > 0 ? '0 0 8px rgba(52, 199, 89, 0.4)' : 'none',
          animation: diffs.length > 0 ? 'livePulse 2.5s ease-in-out infinite' : 'none',
          flexShrink: 0,
        }} />
        <span style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'rgba(226, 232, 240, 0.85)',
          letterSpacing: '-0.01em',
        }}>
          {headerName}
        </span>
        {runtimeLabel && <span style={{
          fontSize: 10,
          color: 'rgba(148, 163, 184, 0.4)',
        }}>
          {runtimeLabel}
        </span>}

        {/* Terminal indicator */}
        {hasTerminal && (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            paddingTop: 1,
            paddingRight: 6,
            paddingBottom: 1,
            paddingLeft: 5,
            borderRadius: 4,
            background: 'rgba(147, 197, 253, 0.08)',
            border: '1px solid rgba(147, 197, 253, 0.1)',
            fontSize: 9,
            fontWeight: 500,
            color: 'rgba(147, 197, 253, 0.6)',
            fontFamily: 'ui-monospace, "SF Mono", Monaco, monospace',
          }}>
            <Terminal size={9} />
            tmux
          </span>
        )}

        {/* Total stats */}
        {(totalAdds > 0 || totalDels > 0) && (
          <span style={{
            fontSize: 10,
            fontFamily: 'ui-monospace, "SF Mono", Monaco, monospace',
            fontWeight: 600,
            display: 'flex',
            gap: 4,
          }}>
            {totalAdds > 0 && <span style={{ color: 'rgba(52, 211, 153, 0.7)' }}>+{totalAdds}</span>}
            {totalDels > 0 && <span style={{ color: 'rgba(147, 197, 253, 0.5)' }}>-{totalDels}</span>}
          </span>
        )}

        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => { const next = !collapsed; setCollapsed(next); onCollapseChange?.(next); }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', color: 'rgba(148, 163, 184, 0.4)' }}
        >
          <ChevronDown size={13} style={{ transition: 'transform 200ms', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }} />
        </button>
        {onClose && <button
          type="button"
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', color: 'rgba(148, 163, 184, 0.3)' }}
          onMouseEnter={(e) => { (e.target as HTMLElement).style.color = 'rgba(239, 68, 68, 0.7)'; }}
          onMouseLeave={(e) => { (e.target as HTMLElement).style.color = 'rgba(148, 163, 184, 0.3)'; }}
        >
          <X size={13} />
        </button>}
      </div>

      {/* File summary bar */}
      {!collapsed && !standaloneTerminal && diffs.length > 0 && <FileSummaryBar diffs={diffs} />}

      {/* Content area: diff cards + terminal split */}
      {!collapsed && (
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          minHeight: 0,
        }}>
          {/* Diff cards section (hidden in standalone terminal mode) */}
          {!standaloneTerminal && (
            <div
              ref={scrollRef}
              style={{
                flex: hasTerminal ? `0 0 ${splitPct}%` : 1,
                overflow: 'auto',
                paddingTop: 6,
                paddingRight: 10,
                paddingBottom: hasTerminal ? 2 : 10,
                paddingLeft: 10,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              {diffs.length === 0 && !hasTerminal ? (
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flex: 1,
                  gap: 8,
                }}>
                  <FileCode size={24} color="rgba(148, 163, 184, 0.12)" />
                  <span style={{ fontSize: 12, color: 'rgba(148, 163, 184, 0.25)', fontStyle: 'italic' }}>
                    Watching for changes...
                  </span>
                </div>
              ) : (
                diffs.map((diff, i) => (
                  <DiffCard key={diff.id} diff={diff} isLatest={i === diffs.length - 1} />
                ))
              )}
            </div>
          )}

          {/* Drag handle between cards and terminal (only when both visible) */}
          {hasTerminal && !standaloneTerminal && (
            <div
              onMouseDown={startSplitDrag}
              style={{
                height: 5,
                cursor: 'row-resize',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                background: 'rgba(147, 197, 253, 0.03)',
              }}
            >
              <div style={{
                width: 32,
                height: 2,
                borderRadius: 1,
                backgroundColor: 'rgba(147, 197, 253, 0.15)',
                transition: 'background-color 150ms',
              }} />
            </div>
          )}

          {/* Terminal section */}
          {hasTerminal && (
            <div
              ref={termContainerRef}
              style={{
                flex: 1,
                minHeight: 150,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                borderTop: standaloneTerminal ? 'none' : '1px solid rgba(147, 197, 253, 0.05)',
              }}
            >
              <InlineTerminal
                ref={terminalRef}
                tmuxSession={tmuxSession!}
                sendTerminalAttach={sendTerminalAttach}
                sendTerminalInput={sendTerminalInput}
                sendTerminalResize={sendTerminalResize}
                sendTerminalDetach={sendTerminalDetach}
                onTerminalData={onTerminalData}
                onTerminalAttached={onTerminalAttached}
                onTerminalExited={onTerminalExited}
                onTerminalError={onTerminalError}
              />
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes livePulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @keyframes diffCardSlideIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
