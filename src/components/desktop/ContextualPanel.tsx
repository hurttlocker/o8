'use client';

/**
 * ContextualPanel — global operator terminal in the bottom panel.
 *
 * This surface stays unscoped on purpose:
 * - scratch shell work
 * - quick command execution
 * - general operator utilities
 *
 * Repo-owned inspectors and task surfaces belong in repo-scoped workspace panes.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { BottomXtermPanel, type XtermPanelHandle } from '@/components/desktop/BottomXtermPanel';
import { useExperimentalOpencodeFlag } from '@/lib/operator/use-experimental-opencode';
import { useExperimentalGeminiFlag } from '@/lib/operator/use-experimental-gemini';
import type { DetectedLocalhostPreview } from '@/lib/panel/preview';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { attachLiveAgentTerminalTab } from '@/components/desktop/contextual-panel/live-agent-terminal';
import { useContextualTabClose } from '@/components/desktop/contextual-panel/use-tab-close';

import { CLI_AGENTS, AgentGlyph, AgentDot, TerminalIcon, FilesIcon, PlusIcon, XIcon, BOTTOM_PANEL_SURFACES, SURFACE_LABELS, BottomUtilitySurface, type CliAgent } from './contextual-panel/surfaces';

// ── Types ──

export interface ContextualPanelHandle {
  confirmClose?: () => Promise<boolean>;
  onSessionCreated: (sessionName: string, requestId?: string) => boolean;
  writeToTerminal: (sessionName: string, data: string) => void;
  showImage: (sessionName: string, imageB64: string, filename: string) => void;
  setTermError: (sessionName: string, error: string) => void;
  setTermExited: (sessionName: string) => void;
  /** Returns the current tmux session name, or null if not connected */
  getSession: () => string | null;
  /** Ensure a terminal exists, then run the command inside it. */
  runCommand: (command: string) => void;
  /** Open or focus one of the bottom panel's non-terminal utility surfaces. */
  openSurface: (surface: BottomPanelSurfaceKind) => void;
  /** Attach a live, read-only view of an o8-owned run session (`o8 run`). */
  attachLiveAgentTerminal: (session: string, label?: string) => void;
}

export type BottomPanelSurfaceKind = 'files' | 'side-chat' | 'browser' | 'review' | 'terminal';

export interface ContextualPanelProps {
  sendTerminalCreate: (cols: number, rows: number, requestId?: string, cwd?: string) => void;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach: (sessionName: string) => void;
  sendAgentKill: (sessionName: string, signal?: 'SIGTERM' | 'SIGINT') => void;
  termWsConnected: boolean;
  repoPath?: string | null;
  repoLabel?: string | null;
  registeredRepos?: RepoRegistryEntry[];
  previews?: DetectedLocalhostPreview[];
  onRepoPathChange?: (repoPath: string) => void;
  onSplitVertical?: () => void;
  panelLabel?: string;
  showPanelLabel?: boolean;
  onClose: () => void;
}

export interface ContextualPanelTab {
  id: string;
  label: string;
  kind: BottomPanelSurfaceKind;
  agentId?: (typeof CLI_AGENTS)[number]['id'];
  tmuxSession: string | null;
  /** true for `o8 run` agent-run views — live output, input guarded. */
  readOnly?: boolean;
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
      repoPath = null,
      repoLabel = null,
      registeredRepos = [],
      previews = [],
      onRepoPathChange,
      panelLabel = 'Bottom Panel',
      showPanelLabel = true,
      onClose,
    },
    ref,
  ) {
    const [tabs, setTabs] = useState<ContextualPanelTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string>('');
    const [addMenuOpen, setAddMenuOpen] = useState(false);
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const opencodeEnabled = useExperimentalOpencodeFlag();
    const geminiEnabled = useExperimentalGeminiFlag();
    const visibleAgents = CLI_AGENTS.filter((a) =>
      (a.id !== 'opencode' || opencodeEnabled) && (a.id !== 'gemini' || geminiEnabled),
    );
    const pendingTabIdsRef = useRef<string[]>([]);
    const pendingAgentsRef = useRef<Map<string, CliAgent['id']>>(new Map());
    const pendingRequestRef = useRef<Map<string, string>>(new Map());
    const pendingCommandsRef = useRef<Map<string, string>>(new Map());
    const tabCountRef = useRef(0);
    const tabsRef = useRef<ContextualPanelTab[]>([]);
    const xtermRefs = useRef<Map<string, XtermPanelHandle>>(new Map());
    const addMenuRef = useRef<HTMLDivElement>(null);
    const dirtyFiles = useMemo(() => new Set<string>(), []);
    const panelLabelLower = panelLabel.toLowerCase();

    useEffect(() => { tabsRef.current = tabs; }, [tabs]);

    const createBottomTab = useCallback((agent: CliAgent, initialCommand?: string) => {
      tabCountRef.current += 1;
      const now = Date.now();
      const nextTab: ContextualPanelTab = {
        id: `bottom-tab-${tabCountRef.current}`,
        label: agent.label,
        kind: 'terminal',
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
      sendTerminalCreate(120, 30, requestId, repoPath ?? undefined);
    }, [repoPath, sendTerminalCreate]);

    const createShell = useCallback(() => createBottomTab(CLI_AGENTS[0]), [createBottomTab]);
    const { closeTab: handleCloseTab, confirmPanelClose } = useContextualTabClose({ tabsRef, activeTabId, setTabs, setActiveTabId, sendTerminalDetach, xtermRefs, pendingTabIdsRef, pendingAgentsRef, pendingCommandsRef, pendingRequestRef, createShell, termWsConnected });

    const createSurfaceTab = useCallback((surface: Exclude<BottomPanelSurfaceKind, 'terminal'>) => {
      const existing = tabsRef.current.find((tab) => tab.kind === surface);
      if (existing) {
        setActiveTabId(existing.id);
        return existing.id;
      }

      tabCountRef.current += 1;
      const now = Date.now();
      const nextTab: ContextualPanelTab = {
        id: `bottom-${surface}-${tabCountRef.current}`,
        label: SURFACE_LABELS[surface],
        kind: surface,
        tmuxSession: null,
        createdAt: now,
        lastActivity: now,
      };
      setTabs((prev) => [...prev, nextTab]);
      setActiveTabId(nextTab.id);
      return nextTab.id;
    }, []);

    const openSurface = useCallback((surface: BottomPanelSurfaceKind) => {
      setAddMenuOpen(false);
      if (surface === 'terminal') {
        const existingTerminal = tabsRef.current.find((tab) => tab.kind === 'terminal' && tab.tmuxSession);
        if (existingTerminal) {
          setActiveTabId(existingTerminal.id);
          return existingTerminal.id;
        }
        createBottomTab(CLI_AGENTS[0]);
        return null;
      }
      return createSurfaceTab(surface);
    }, [createBottomTab, createSurfaceTab]);

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
      confirmClose: confirmPanelClose,
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
      getSession: () => tabsRef.current.find((entry) => entry.id === activeTabId && entry.kind === 'terminal')?.tmuxSession ?? null,
      runCommand: (command: string) => {
        // Skip read-only watch tabs (`o8 run` views) — never inject into an agent's PTY.
        const activeTab = tabsRef.current.find((entry) => entry.id === activeTabId && entry.kind === 'terminal' && !entry.readOnly);
        if (activeTab?.tmuxSession) {
          sendTerminalInput(activeTab.tmuxSession, command + '\n');
          return;
        }

        const existingShell = tabsRef.current.find((entry) => entry.kind === 'terminal' && entry.agentId === 'shell' && entry.tmuxSession);
        if (existingShell?.tmuxSession) {
          setActiveTabId(existingShell.id);
          sendTerminalInput(existingShell.tmuxSession, command + '\n');
          return;
        }

        const pendingShell = tabsRef.current.find((entry) => entry.kind === 'terminal' && entry.agentId === 'shell' && !entry.tmuxSession);
        if (pendingShell) {
          pendingCommandsRef.current.set(pendingShell.id, command);
          setActiveTabId(pendingShell.id);
          return;
        }

        createBottomTab(CLI_AGENTS[0], command);
      },
      openSurface,
      attachLiveAgentTerminal: (session: string, label?: string) => {
        setAddMenuOpen(false);
        const result = attachLiveAgentTerminalTab(tabsRef.current, {
          session,
          label,
          tabCount: tabCountRef.current,
        });
        tabCountRef.current = result.nextTabCount;
        tabsRef.current = result.tabs;
        setTabs(result.tabs);
        setActiveTabId(result.activeTabId);
      },
    }), [activeTabId, confirmPanelClose, createBottomTab, openSurface, sendTerminalInput]);

    const handleCreateTab = useCallback((agent: CliAgent) => {
      setAddMenuOpen(false);
      createBottomTab(agent);
    }, [createBottomTab]);

    const handleCreateSurface = useCallback((surface: BottomPanelSurfaceKind) => {
      openSurface(surface);
    }, [openSurface]);

    return (
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--t-bg)',
        // Own stacking context ABOVE unpositioned siblings: the workspace
        // card's Lisse drop shadow was painting over the panel header in
        // light glass, dimming the +/× controls into invisibility
        // (Q report 2026-07-14 — "the shell + button is behind the
        // workspace, I can see the shadow"). z 1 wins over shadow bleed
        // from auto-stacked siblings without touching overlay layers.
        position: 'relative',
        zIndex: 1,
        isolation: 'isolate',
      } as React.CSSProperties}>
        {/* Header bar — single-line bottom panel chrome */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          height: 36,
          flexShrink: 0,
          background: 'var(--t-chrome, var(--t-panel))',
          borderBottom: '1px solid var(--t-divider)',
          paddingLeft: 8,
          paddingRight: 8,
          position: 'relative',
          zIndex: 30,
          color: 'var(--t-text-secondary)',
        } as React.CSSProperties}>
          {showPanelLabel ? <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            flexShrink: 0,
            minWidth: 0,
            paddingRight: 10,
            borderRight: '1px solid var(--t-divider)',
          }}>
            <TerminalIcon size={13} />
            <span style={{
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '-0.01em',
              color: 'var(--t-text)',
              whiteSpace: 'nowrap',
            }}>
              {panelLabel}
            </span>
          </div> : null}

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
              const agent = tab.kind === 'terminal'
                ? CLI_AGENTS.find((entry) => entry.id === tab.agentId) ?? CLI_AGENTS[0]
                : null;
              const SurfaceIcon = tab.kind === 'terminal'
                ? null
                : BOTTOM_PANEL_SURFACES.find((entry) => entry.id === tab.kind)?.icon ?? FilesIcon;
              const isActive = tab.id === activeTabId;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setActiveTabId(tab.id);
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
                    background: isActive ? 'var(--t-panel-hover)' : 'transparent',
                    boxShadow: 'none',
                    color: isActive ? 'var(--t-text)' : 'var(--t-text-muted)',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  {agent
                    ? (agent.id === 'shell'
                        ? <AgentDot color={agent.color} />
                        : <AgentGlyph agentId={agent.id} size={12} />)
                    : SurfaceIcon?.({ size: 12 })}
                  <span style={{
                    fontSize: 12,
                    fontWeight: 300,
                    letterSpacing: '-0.1px',
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
                        color: 'var(--t-text-faint)',
                      }}
                    >
                      <XIcon size={10} />
                    </span>
                  )}
                </button>
              );
            })}

          </div>

          <div ref={addMenuRef} style={{ position: 'relative', flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setAddMenuOpen((prev) => !prev)}
              aria-label={`Add ${panelLabelLower} tab`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                borderRadius: 8,
                border: 'none',
                background: 'transparent',
                color: 'var(--t-text-muted)',
                cursor: 'pointer',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-panel-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <PlusIcon size={14} />
            </button>

            {addMenuOpen && (
              <div style={{
                position: 'absolute',
                // Opens UPWARD: the + lives in the bottom panel's header, so
                // downward growth clips at the window edge whenever the panel
                // is short — above the header there is always the full app.
                bottom: 'calc(100% + 6px)',
                right: 0,
                width: 320,
                borderRadius: 14,
                background: 'var(--t-popover-surface)',
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
                {/* Terminal-first (Q 2026-07-14): the + on the terminal panel
                    means "another shell" far more often than "another panel
                    surface", so the shells lead in one flat row vocabulary and
                    the panel surfaces follow as the same quiet rows below a
                    divider. The old layout led with a chunky 2-col card grid
                    (and a redundant Terminal card next to the Shell row). */}
                {visibleAgents.map((agent) => (
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
                    <span style={{
                      width: 18,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      {agent.id === 'shell'
                        ? <AgentDot color={agent.color} />
                        : <AgentGlyph agentId={agent.id} size={16} />}
                    </span>
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
                <div style={{ borderTop: '1px solid var(--t-divider-subtle)', marginTop: 4, paddingTop: 4 }}>
                  {BOTTOM_PANEL_SURFACES.filter((surface) => surface.id !== 'terminal').map((surface) => {
                    const SurfaceIcon = surface.icon;
                    return (
                      <button
                        key={surface.id}
                        type="button"
                        onClick={() => handleCreateSurface(surface.id)}
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
                        <span style={{
                          width: 18,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          color: 'var(--t-text-secondary)',
                        }}>
                          {SurfaceIcon({ size: 14 })}
                        </span>
                        <span style={{
                          fontSize: 12,
                          fontWeight: 500,
                          color: 'var(--t-text)',
                          flex: 1,
                        }}>
                          {surface.label}
                        </span>
                        <span style={{
                          fontSize: 10,
                          fontWeight: 300,
                          color: 'var(--t-text-faint)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}>
                          {surface.description}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Split-vertical button removed 2026-05-27 — bottom panel
              leans on tabs for multiple surfaces. */}

          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${panelLabelLower}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 24,
              height: 24,
              borderRadius: 8,
              border: 'none',
              background: 'transparent',
              color: 'var(--t-text-muted)',
              cursor: 'pointer',
              padding: 0,
              flexShrink: 0,
              transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-panel-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <XIcon size={14} />
          </button>
        </div>

        {/* Panel body */}
        {tabs.length > 0 ? (
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {tabs.map((tab) => (
              tab.kind === 'terminal' && tab.tmuxSession ? (
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
                  readOnly={tab.readOnly}
                />
              ) : tab.kind === 'terminal' ? (
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
              ) : (
                <div
                  key={tab.id}
                  aria-hidden={tab.id !== activeTabId}
                  style={{
                    display: tab.id === activeTabId ? 'flex' : 'none',
                    flex: 1,
                    minHeight: 0,
                    height: '100%',
                    background: 'var(--t-bg)',
                    overflow: 'hidden',
                  }}
                >
                  <BottomUtilitySurface
                    kind={tab.kind}
                    tabId={tab.id}
                    active={tab.id === activeTabId}
                    repoPath={repoPath}
                    repoLabel={repoLabel}
                    registeredRepos={registeredRepos}
                    previews={previews}
                    selectedFile={selectedFile}
                    dirtyFiles={dirtyFiles}
                    onSelectFile={setSelectedFile}
                    onRepoPathChange={onRepoPathChange}
                  />
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
