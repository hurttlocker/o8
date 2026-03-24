'use client';

/**
 * ContextualPanel — interactive terminal in the bottom contextual panel.
 *
 * Single tmux session with CLI agent picker (Shell, Claude Code, Codex, etc.).
 * Replaces LiveOutput when no canvas tabs are open.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type React from 'react';
import { Canvas } from './Canvas';

// ── CLI Agents (terminal only, no chat modes) ──

const CLI_AGENTS = [
  { id: 'shell', label: 'Shell', color: '#64748b', command: null },
  { id: 'claude', label: 'Claude Code', color: '#e07a3a', command: 'claude' },
  { id: 'codex', label: 'Codex', color: '#6b7280', command: 'codex' },
  { id: 'gemini', label: 'Gemini CLI', color: '#4285f4', command: 'gemini' },
  { id: 'opencode', label: 'OpenCode', color: '#f97316', command: 'opencode' },
  { id: 'aider', label: 'Aider', color: '#eab308', command: 'aider' },
] as const;

type CliAgent = (typeof CLI_AGENTS)[number];

// ── Types ──

export interface ContextualPanelHandle {
  onSessionCreated: (sessionName: string, requestId?: string) => boolean;
  writeToTerminal: (sessionName: string, data: string) => void;
  showImage: (sessionName: string, imageB64: string, filename: string) => void;
  setTermError: (sessionName: string, error: string) => void;
  setTermExited: (sessionName: string) => void;
  /** Returns the current tmux session name, or null if not connected */
  getSession: () => string | null;
  /** Ensure a terminal exists, then run the command inside it. */
  runCommand: (command: string) => void;
}

export interface ContextualPanelProps {
  sendTerminalCreate: (cols: number, rows: number, requestId?: string) => void;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach: (sessionName: string) => void;
  sendAgentKill: (sessionName: string, signal?: 'SIGTERM' | 'SIGINT') => void;
  termWsConnected: boolean;
  // Canvas tabs (issues, diffs, files, timeline — rendered as tabs alongside terminals)
  canvasTabs?: import('./Canvas').CanvasTab[];
  activeCanvasTabId?: string | null;
  onSelectCanvasTab?: (tabId: string) => void;
  onCloseCanvasTab?: (tabId: string) => void;
  onInjectChatContext?: (payload: import('@/lib/chat/injection').AgentPanelChatInjectionPayload) => void;
  onSelectCommit?: (hash: string) => void;
  onClose: () => void;
}

// ── Helpers ──

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

// Lucide icons as raw SVG (Tauri webview compatibility)
function TerminalIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  );
}

function XIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

// ── Inline XtermPanel (mirrors TerminalWorkspace pattern) ──

interface InlineImage {
  id: string;
  dataUrl: string;
  filename: string;
}

interface XtermPanelHandle {
  writeData: (data: string) => void;
  showImage: (imageB64: string, filename: string) => void;
  setError: (error: string) => void;
  setExited: () => void;
}

const BottomXtermPanel = forwardRef<XtermPanelHandle, {
  tmuxSession: string;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach: (sessionName: string) => void;
  visible: boolean;
}>(function BottomXtermPanel(
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
        const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        termRef.current.write(bytes);
      } catch { /* ignore decode errors */ }
    },
    showImage: (imageB64: string, filename: string) => {
      const ext = filename.split('.').pop()?.toLowerCase() ?? 'png';
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'svg' ? 'image/svg+xml' : 'image/png';
      const dataUrl = `data:${mime};base64,${imageB64}`;
      imageCountRef.current += 1;
      setInlineImages(prev => [...prev, { id: `img-${imageCountRef.current}`, dataUrl, filename }]);
      if (termRef.current) termRef.current.write('\r\n\r\n');
    },
    setError: (err: string) => setError(err),
    setExited: () => setExited(true),
  }), []);

  useEffect(() => {
    if (!visible || !fitAddonRef.current || !termRef.current) return;
    const timer = setTimeout(() => {
      try {
        fitAddonRef.current?.fit();
        sendTerminalResize(tmuxSession, termRef.current.cols, termRef.current.rows);
      } catch { /* ignore */ }
    }, 50);
    return () => clearTimeout(timer);
  }, [visible, sendTerminalResize, tmuxSession]);

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
          pixelLimit: 16777216,
          sixelSupport: true,
          sixelScrolling: true,
          sixelPaletteLimit: 4096,
          iipSupport: true,
          iipSizeLimit: 20000000,
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

        sendTerminalAttach(tmuxSession, term.cols, term.rows);
        term.onData((data) => { sendTerminalInput(tmuxSession, data); });

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
      overflow: 'hidden',
    }}>
      {inlineImages.map((img) => (
        <div key={img.id} style={{
          paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 12,
          borderBottom: '1px solid #f1f5f9', flexShrink: 0,
        }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={img.dataUrl} alt={img.filename} style={{
            maxWidth: '100%', maxHeight: 400, borderRadius: 8, objectFit: 'contain',
          }} />
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4, fontFamily: 'ui-monospace, monospace' }}>
            {img.filename}
          </div>
        </div>
      ))}
      <div ref={containerRef} style={{
        flex: 1, width: '100%', background: '#ffffff', paddingTop: 2, paddingLeft: 2,
      }} />
    </div>
  );
});

// ── Main Component ──

interface ContextualPanelTab {
  id: string;
  label: string;
  agentId: CliAgent['id'];
  tmuxSession: string | null;
  createdAt: number;
  lastActivity: number;
}

export const ContextualPanel = forwardRef<ContextualPanelHandle, ContextualPanelProps>(
  function ContextualPanel(
    {
      sendTerminalCreate,
      sendTerminalAttach,
      sendTerminalInput,
      sendTerminalResize,
      sendTerminalDetach,
      termWsConnected,
      canvasTabs,
      activeCanvasTabId,
      onSelectCanvasTab,
      onCloseCanvasTab,
      onInjectChatContext,
      onSelectCommit,
      onClose,
    },
    ref,
  ) {
    const [tabs, setTabs] = useState<ContextualPanelTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string>('');
    const [addMenuOpen, setAddMenuOpen] = useState(false);
    const pendingTabIdsRef = useRef<string[]>([]);
    const pendingAgentsRef = useRef<Map<string, CliAgent['id']>>(new Map());
    const pendingRequestRef = useRef<Map<string, string>>(new Map());
    const pendingCommandsRef = useRef<Map<string, string>>(new Map());
    const tabCountRef = useRef(0);
    const tabsRef = useRef<ContextualPanelTab[]>([]);
    const xtermRefs = useRef<Map<string, XtermPanelHandle>>(new Map());
    const addMenuRef = useRef<HTMLDivElement>(null);

    useEffect(() => { tabsRef.current = tabs; }, [tabs]);

    const createBottomTab = useCallback((agent: CliAgent, initialCommand?: string) => {
      tabCountRef.current += 1;
      const now = Date.now();
      const nextTab: ContextualPanelTab = {
        id: `bottom-tab-${tabCountRef.current}`,
        label: agent.label,
        agentId: agent.id,
        tmuxSession: null,
        createdAt: now,
        lastActivity: now,
      };
      const requestId = `bottom-${nextTab.id}-${now}`;
      pendingAgentsRef.current.set(nextTab.id, agent.id);
      pendingTabIdsRef.current.push(nextTab.id);
      pendingRequestRef.current.set(requestId, nextTab.id);
      const commandParts = [agent.command, initialCommand].filter(Boolean);
      if (commandParts.length > 0) {
        pendingCommandsRef.current.set(nextTab.id, commandParts.join(' && '));
      }
      setTabs((prev) => [...prev, nextTab]);
      setActiveTabId(nextTab.id);
      sendTerminalCreate(120, 30, requestId);
    }, [sendTerminalCreate]);

    // Close add menu on outside click
    useEffect(() => {
      if (!addMenuOpen) return;
      const handler = (e: MouseEvent) => {
        if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
          setAddMenuOpen(false);
        }
      };
      const timer = setTimeout(() => document.addEventListener('mousedown', handler), 100);
      return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler); };
    }, [addMenuOpen]);

    // Create default shell tab on mount / reconnect
    useEffect(() => {
      if (!termWsConnected || tabsRef.current.length > 0 || pendingTabIdsRef.current.length > 0) return;
      createBottomTab(CLI_AGENTS[0]);
    }, [createBottomTab, termWsConnected]);

    // Imperative handle for dashboard event routing
    useImperativeHandle(ref, () => ({
      onSessionCreated: (sessionName: string, requestId?: string) => {
        const matchedTabId = requestId ? pendingRequestRef.current.get(requestId) : undefined;
        const nextTabId = matchedTabId ?? pendingTabIdsRef.current.shift();
        if (!nextTabId) return false;
        if (requestId) {
          pendingRequestRef.current.delete(requestId);
          pendingTabIdsRef.current = pendingTabIdsRef.current.filter((entry) => entry !== nextTabId);
        }
        pendingAgentsRef.current.delete(nextTabId);

        setTabs((prev) => prev.map((entry) => (
          entry.id === nextTabId
            ? { ...entry, tmuxSession: sessionName, lastActivity: Date.now() }
            : entry
        )));

        const pendingCommand = pendingCommandsRef.current.get(nextTabId);
        pendingCommandsRef.current.delete(nextTabId);

        if (pendingCommand) {
          fetch('/api/panel/terminal-exec', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionName, command: pendingCommand }),
          }).catch(() => {
            // Fallback: send via WS input
            setTimeout(() => sendTerminalInput(sessionName, pendingCommand + '\n'), 2000);
          });
        }
        return true;
      },
      writeToTerminal: (sessionName: string, data: string) => {
        xtermRefs.current.get(sessionName)?.writeData(data);
        setTabs((prev) => prev.map((entry) => (
          entry.tmuxSession === sessionName
            ? { ...entry, lastActivity: Date.now() }
            : entry
        )));
      },
      showImage: (sessionName: string, imageB64: string, filename: string) => {
        xtermRefs.current.get(sessionName)?.showImage(imageB64, filename);
      },
      setTermError: (sessionName: string, error: string) => {
        xtermRefs.current.get(sessionName)?.setError(error);
      },
      setTermExited: (sessionName: string) => {
        xtermRefs.current.get(sessionName)?.setExited();
      },
      getSession: () => tabsRef.current.find((entry) => entry.id === activeTabId)?.tmuxSession ?? null,
      runCommand: (command: string) => {
        const activeTab = tabsRef.current.find((entry) => entry.id === activeTabId);
        if (activeTab?.tmuxSession) {
          sendTerminalInput(activeTab.tmuxSession, command + '\n');
          return;
        }

        const existingShell = tabsRef.current.find((entry) => entry.agentId === 'shell' && entry.tmuxSession);
        if (existingShell?.tmuxSession) {
          setActiveTabId(existingShell.id);
          sendTerminalInput(existingShell.tmuxSession, command + '\n');
          return;
        }

        const pendingShell = tabsRef.current.find((entry) => entry.agentId === 'shell' && !entry.tmuxSession);
        if (pendingShell) {
          pendingCommandsRef.current.set(pendingShell.id, command);
          setActiveTabId(pendingShell.id);
          return;
        }

        createBottomTab(CLI_AGENTS[0], command);
      },
    }), [activeTabId, createBottomTab, sendTerminalInput]);

    const handleCreateTab = useCallback((agent: CliAgent) => {
      setAddMenuOpen(false);
      createBottomTab(agent);
    }, [createBottomTab]);

    const handleCloseTab = useCallback((tabId: string) => {
      const tab = tabsRef.current.find((entry) => entry.id === tabId);
      if (!tab) return;

      if (tab.tmuxSession) {
        sendTerminalDetach(tab.tmuxSession);
        xtermRefs.current.delete(tab.tmuxSession);
      } else {
        pendingTabIdsRef.current = pendingTabIdsRef.current.filter((entry) => entry !== tabId);
        pendingAgentsRef.current.delete(tabId);
        pendingCommandsRef.current.delete(tabId);
        for (const [requestId, pendingTabId] of pendingRequestRef.current) {
          if (pendingTabId === tabId) pendingRequestRef.current.delete(requestId);
        }
      }

      const remaining = tabsRef.current.filter((entry) => entry.id !== tabId);
      setTabs(remaining);

      if (remaining.length === 0) {
        setActiveTabId('');
        if (termWsConnected) {
          createBottomTab(CLI_AGENTS[0]);
        }
        return;
      }

      if (activeTabId === tabId) {
        const idx = tabsRef.current.findIndex((entry) => entry.id === tabId);
        const nextIdx = Math.min(idx, remaining.length - 1);
        setActiveTabId(remaining[nextIdx].id);
      }
    }, [activeTabId, createBottomTab, sendTerminalDetach, termWsConnected]);

    return (
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--t-bg-subtle)',
      }}>
        {/* Header bar — matches Canvas tab bar */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 36,
          flexShrink: 0,
          background: 'var(--t-panel-translucent)',
          backdropFilter: 'blur(20px) saturate(1.6)',
          WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
          borderBottom: '1px solid var(--t-divider)',
          paddingLeft: 8,
          paddingRight: 8,
          position: 'relative',
          zIndex: 30,
        } as React.CSSProperties}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            flex: 1,
            minWidth: 0,
            overflowX: 'auto',
            overflowY: 'hidden',
          }}>
            {tabs.map((tab) => {
              const agent = CLI_AGENTS.find((entry) => entry.id === tab.agentId) ?? CLI_AGENTS[0];
              const isActive = tab.id === activeTabId;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTabId(tab.id)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 28,
                    paddingTop: 0,
                    paddingRight: 10,
                    paddingBottom: 0,
                    paddingLeft: 10,
                    borderRadius: 8,
                    border: 'none',
                    background: isActive ? 'var(--t-panel)' : 'transparent',
                    boxShadow: isActive ? 'var(--t-panel-shadow)' : 'none',
                    color: isActive ? 'var(--t-text)' : 'var(--t-text-secondary)',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  <AgentDot color={agent.color} />
                  <span style={{
                    fontSize: 12,
                    fontWeight: isActive ? 600 : 500,
                    whiteSpace: 'nowrap',
                  }}>
                    {tab.label}
                  </span>
                  {tabs.length > 1 && (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCloseTab(tab.id);
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 16,
                        height: 16,
                        borderRadius: 4,
                        color: 'var(--t-text-muted)',
                      }}
                    >
                      <XIcon size={10} />
                    </span>
                  )}
                </button>
              );
            })}

            {/* Canvas tabs (issues, diffs, files, timeline) */}
            {canvasTabs && canvasTabs.length > 0 && (
              <>
                <div style={{ width: 1, height: 16, background: 'var(--t-divider)', flexShrink: 0 }} />
                {canvasTabs.map((ct) => {
                  const isActive = ct.id === activeCanvasTabId && !activeTabId;
                  return (
                    <button
                      key={ct.id}
                      type="button"
                      onClick={() => {
                        setActiveTabId(''); // deselect terminal tabs
                        onSelectCanvasTab?.(ct.id);
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        height: 28,
                        paddingTop: 0,
                        paddingRight: 10,
                        paddingBottom: 0,
                        paddingLeft: 10,
                        borderRadius: 8,
                        border: 'none',
                        background: isActive ? 'var(--t-panel)' : 'transparent',
                        boxShadow: isActive ? 'var(--t-panel-shadow)' : 'none',
                        color: isActive ? 'var(--t-text)' : 'var(--t-text-secondary)',
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                    >
                      <span style={{ fontSize: 12, fontWeight: isActive ? 600 : 500, whiteSpace: 'nowrap' }}>
                        {ct.label}
                      </span>
                      <span
                        onClick={(e) => { e.stopPropagation(); onCloseCanvasTab?.(ct.id); }}
                        style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          width: 16, height: 16, borderRadius: 4, color: 'var(--t-text-muted)',
                        }}
                      >
                        <XIcon size={10} />
                      </span>
                    </button>
                  );
                })}
              </>
            )}
          </div>

          <div ref={addMenuRef} style={{ position: 'relative', flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setAddMenuOpen((prev) => !prev)}
              aria-label="Add terminal tab"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                borderRadius: 8,
                border: 'none',
                background: 'transparent',
                color: 'var(--t-text-secondary)',
                cursor: 'pointer',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <PlusIcon size={14} />
            </button>

            {addMenuOpen && (
              <div style={{
                position: 'absolute',
                top: 'calc(100% + 6px)',
                right: 0,
                width: 220,
                borderRadius: 14,
                background: 'var(--t-panel)',
                backdropFilter: 'blur(24px) saturate(1.6)',
                WebkitBackdropFilter: 'blur(24px) saturate(1.6)',
                border: '1px solid var(--t-divider)',
                boxShadow: '0 12px 40px rgba(15, 23, 42, 0.15), 0 2px 6px rgba(15, 23, 42, 0.06)',
                paddingTop: 4,
                paddingRight: 4,
                paddingBottom: 4,
                paddingLeft: 4,
                zIndex: 400,
              } as React.CSSProperties}>
                {CLI_AGENTS.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => handleCreateTab(agent)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      paddingTop: 7,
                      paddingRight: 10,
                      paddingBottom: 7,
                      paddingLeft: 10,
                      borderRadius: 10,
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <AgentDot color={agent.color} />
                    <span style={{
                      fontSize: 12,
                      fontWeight: 500,
                      color: 'var(--t-text)',
                      flex: 1,
                    }}>
                      {agent.label}
                    </span>
                    {agent.command && (
                      <span style={{
                        fontSize: 10,
                        fontFamily: 'ui-monospace, "SF Mono", monospace',
                        color: 'var(--t-text-faint)',
                      }}>
                        $ {agent.command}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Close button */}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close terminal panel"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 24,
              height: 24,
              borderRadius: 8,
              border: 'none',
              background: 'transparent',
              color: 'var(--t-text-secondary)',
              cursor: 'pointer',
              padding: 0,
              flexShrink: 0,
              transition: 'background 120ms ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <XIcon size={14} />
          </button>
        </div>

        {/* Canvas content — shown when a canvas tab is active */}
        {!activeTabId && activeCanvasTabId && canvasTabs && canvasTabs.length > 0 && (
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <Canvas
              tabs={canvasTabs}
              activeTabId={activeCanvasTabId}
              onSelectTab={(id) => onSelectCanvasTab?.(id)}
              onCloseTab={(id) => onCloseCanvasTab?.(id)}
              onInjectChatContext={onInjectChatContext}
              onSelectCommit={onSelectCommit}
              embedded
            />
          </div>
        )}

        {/* Terminal body — shown when a terminal tab is active */}
        {activeTabId && tabs.length > 0 ? (
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
            {tabs.map((tab) => (
              tab.tmuxSession ? (
                <BottomXtermPanel
                  key={tab.tmuxSession}
                  ref={(handle) => {
                    if (handle) xtermRefs.current.set(tab.tmuxSession!, handle);
                    else xtermRefs.current.delete(tab.tmuxSession!);
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
                    gap: 8,
                    color: 'var(--t-text-faint)',
                    fontSize: 14,
                    height: '100%',
                  }}
                >
                  <TerminalIcon size={18} />
                  Connecting...
                </div>
              )
            ))}
          </div>
        ) : (
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            color: 'var(--t-text-faint)',
            fontSize: 14,
          }}>
            <TerminalIcon size={18} />
            Connecting...
          </div>
        )}
      </div>
    );
  },
);
