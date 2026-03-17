'use client';

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Plus, X, Terminal as TerminalIcon, ChevronDown } from 'lucide-react';

/* ── Types ── */

export interface TerminalTab {
  id: string;
  label: string;
  tmuxSession: string | null; // null = pending creation
  cliAgent?: string; // which CLI agent was launched (or 'shell')
}

export interface TerminalTabHandle {
  writeToTerminal: (sessionName: string, data: string) => void;
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
}

const CLI_AGENTS = [
  { id: 'shell', label: 'Terminal', icon: '⬛', command: null },
  { id: 'claude', label: 'Claude Code', icon: '🟣', command: 'claude' },
  { id: 'codex', label: 'Codex', icon: '🟢', command: 'codex' },
  { id: 'gemini', label: 'Gemini CLI', icon: '🔵', command: 'gemini' },
  { id: 'opencode', label: 'OpenCode', icon: '🟠', command: 'opencode' },
  { id: 'aider', label: 'Aider', icon: '🟡', command: 'aider' },
];

/* ── Inline xterm.js Terminal ── */

interface XtermPanelProps {
  tmuxSession: string;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach: (sessionName: string) => void;
  visible: boolean;
}

interface XtermPanelHandle {
  writeData: (data: string) => void;
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

  useImperativeHandle(ref, () => ({
    writeData: (data: string) => {
      if (!termRef.current) return;
      try {
        termRef.current.write(atob(data));
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
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
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
          fontSize: 13,
          lineHeight: 1.35,
          cursorBlink: true,
          allowTransparency: true,
          scrollback: 10000,
          theme: {
            background: '#ffffff',
            foreground: '#1e293b',
            cursor: '#3b82f6',
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
        term.loadAddon(fitAddon);

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
    <div
      ref={containerRef}
      style={{
        flex: 1,
        width: '100%',
        display: visible ? 'block' : 'none',
        background: '#ffffff',
        borderRadius: 0,
      }}
    />
  );
});

/* ── Tab Bar ── */

const TabBar = memo(function TabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
}: {
  tabs: TerminalTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: (agentId: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

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

  return (
    <div style={{
      display: 'flex',
      alignItems: 'stretch',
      height: 36,
      marginTop: 20,
      background: '#f8fafc',
      borderBottom: '1px solid #e2e8f0',
      flexShrink: 0,
      overflow: 'hidden',
    }}>
      {/* Tabs */}
      <div style={{ display: 'flex', flex: 1, overflow: 'auto', gap: 0 }}>
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
              <span style={{ fontSize: 12 }}>{agent?.icon ?? '⬛'}</span>
              <span>{tab.label}</span>
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
            zIndex: 100,
            marginTop: 4,
            minWidth: 200,
            background: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: 10,
            overflow: 'hidden',
            boxShadow: '0 12px 40px rgba(0, 0, 0, 0.12)',
          }}>
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
                  onNewTab(agent.id);
                  setPickerOpen(false);
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
                <span style={{ fontSize: 16, width: 20, textAlign: 'center' }}>{agent.icon}</span>
                <div>
                  <div style={{ fontWeight: 500 }}>{agent.label}</div>
                  {agent.command && (
                    <div style={{ fontSize: 11, color: '#475569', fontFamily: 'ui-monospace, monospace' }}>
                      $ {agent.command}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

/* ── Main Component ── */

export const TerminalWorkspace = forwardRef<TerminalTabHandle, TerminalWorkspaceProps>(
  function TerminalWorkspace(
    { sendTerminalCreate, sendTerminalAttach, sendTerminalInput, sendTerminalResize, sendTerminalDetach, termWsConnected },
    ref,
  ) {
    const [tabs, setTabs] = useState<TerminalTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string>('');
    const panelRefs = useRef<Map<string, XtermPanelHandle>>(new Map());
    const tabCountRef = useRef(0);
    const pendingCliCommands = useRef<Map<string, string>>(new Map()); // tabId → command to run after session created
    const initialCreatedRef = useRef(false);

    // Create initial shell tab on WS connect
    useEffect(() => {
      if (termWsConnected && !initialCreatedRef.current) {
        initialCreatedRef.current = true;
        sendTerminalCreate(120, 30);
      }
      if (!termWsConnected) {
        initialCreatedRef.current = false;
      }
    }, [termWsConnected, sendTerminalCreate]);

    // Called when WS server confirms a new tmux session was created
    const handleSessionCreated = useCallback((sessionName: string) => {
      setTabs(prev => {
        // Check if there's a tab waiting for a session (tmuxSession === null)
        const pendingIdx = prev.findIndex(t => t.tmuxSession === null);
        if (pendingIdx >= 0) {
          const updated = [...prev];
          updated[pendingIdx] = { ...updated[pendingIdx], tmuxSession: sessionName };
          return updated;
        }
        // No pending tab — this is the initial auto-created session
        tabCountRef.current += 1;
        const newTab: TerminalTab = {
          id: `tab-${tabCountRef.current}`,
          label: 'Shell',
          tmuxSession: sessionName,
          cliAgent: 'shell',
        };
        return [...prev, newTab];
      });
      setActiveTabId(prev => prev || `tab-${tabCountRef.current}`);
    }, []);

    // Route terminal events to the correct tab's XtermPanel
    useImperativeHandle(ref, () => ({
      writeToTerminal: (sessionName: string, data: string) => {
        panelRefs.current.get(sessionName)?.writeData(data);
      },
      setTermError: (sessionName: string, error: string) => {
        panelRefs.current.get(sessionName)?.setError(error);
      },
      setTermExited: (sessionName: string) => {
        panelRefs.current.get(sessionName)?.setExited();
      },
      onSessionCreated: handleSessionCreated,
    }), [handleSessionCreated]);

    const handleNewTab = useCallback((agentId: string) => {
      const agent = CLI_AGENTS.find(a => a.id === agentId);
      if (!agent) return;

      tabCountRef.current += 1;
      const tabId = `tab-${tabCountRef.current}`;
      const newTab: TerminalTab = {
        id: tabId,
        label: agent.label,
        tmuxSession: null, // will be set when WS responds with session name
        cliAgent: agentId,
      };

      // If agent has a CLI command, queue it for execution after session creation
      if (agent.command) {
        pendingCliCommands.current.set(tabId, agent.command);
      }

      setTabs(prev => [...prev, newTab]);
      setActiveTabId(tabId);
      sendTerminalCreate(120, 30);
    }, [sendTerminalCreate]);

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
        return remaining;
      });
    }, [activeTabId, sendTerminalDetach]);

    // When a tab gets its tmux session, check if there's a CLI command to run
    useEffect(() => {
      for (const tab of tabs) {
        if (tab.tmuxSession && pendingCliCommands.current.has(tab.id)) {
          const command = pendingCliCommands.current.get(tab.id)!;
          pendingCliCommands.current.delete(tab.id);
          // Small delay to let terminal initialize
          setTimeout(() => {
            sendTerminalInput(tab.tmuxSession!, command + '\n');
          }, 500);
        }
      }
    }, [tabs, sendTerminalInput]);

    return (
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: '#ffffff',
      }}>
        {/* Tab bar */}
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={setActiveTabId}
          onCloseTab={handleCloseTab}
          onNewTab={handleNewTab}
        />

        {/* Terminal panels — all mounted, only active is visible */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {tabs.map((tab) => (
            tab.tmuxSession ? (
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
