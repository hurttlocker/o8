'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useDesktopWebSocket, type DesktopWsCallbacks } from '@/components/desktop/hooks/useDesktopWebSocket';
import type { WsConnectionState } from '@/components/desktop/hooks/useDesktopWebSocket';
import type { TerminalHandle } from '@/components/desktop/LiveOutput';
import { TerminalWorkspace, type TerminalTabHandle } from '@/components/desktop/TerminalWorkspace';
import { AgentPanel } from '@/components/desktop/AgentPanel';
// WorkspacesPanel merged into AgentPanel — unified agent+workspace view
import { DesktopChat } from '@/components/desktop/DesktopChat';
import { Canvas, CanvasTab } from '@/components/desktop/Canvas';
import { UniversalSearch } from '@/components/shared/UniversalSearch';
import { GraphExplorer3D } from '@/components/desktop/GraphExplorer3D';
import { AlertProvider, useAlerts } from '@/lib/alerts/context';
import { ThemeProvider } from '@/lib/theme/context';
import { AlertBell } from '@/components/shared/AlertBell';
import { AlertTray } from '@/components/shared/AlertTray';
import { AlertToast } from '@/components/shared/AlertToast';
import { NavRail, type NavSection } from '@/components/desktop/NavRail';
import { LiveOutput } from '@/components/desktop/LiveOutput';
import { TitleBar } from '@/components/desktop/TitleBar';
import { SessionTimeline } from '@/components/desktop/SessionTimeline';
import { IntentCanvas } from '@/components/desktop/IntentCanvas';
import { SettingsPage } from '@/components/desktop/SettingsPage';
import { AnalyticsPage } from '@/components/desktop/AnalyticsPage';
import { ThoughtsCard } from '@/components/desktop/ThoughtsCard';

export default function DashboardPage() {
  return (
    <ThemeProvider>
      <AlertProvider>
        <DashboardInner />
      </AlertProvider>
    </ThemeProvider>
  );
}

function DashboardInner() {
  const [leftWidth, setLeftWidth] = useState(300);
  const [rightWidth, setRightWidth] = useState(420);
  const [canvasHeight, setCanvasHeight] = useState(50); // percentage of center column
  const [activeSessionKey, setActiveSessionKey] = useState<string | undefined>();
  const [liveOutputCollapsed, setLiveOutputCollapsed] = useState(false);
  const [dashTermSession, setDashTermSession] = useState<string | null>(null);
  const termCreatedRef = useRef(false);
  const terminalRef = useRef<TerminalHandle>(null);
  const termWorkspaceRef = useRef<TerminalTabHandle>(null);
  const [agentsJson, setAgentsJson] = useState('[]');
  const [activeWorkspace, setActiveWorkspace] = useState<string | undefined>();
  const [showMemoryView, setShowMemoryView] = useState(false);
  const [alertTrayOpen, setAlertTrayOpen] = useState(false);
  const [activeNavSection, setActiveNavSection] = useState<NavSection>('agents');
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [chatVisible, setChatVisible] = useState(true);
  const [bottomPanelVisible, setBottomPanelVisible] = useState(true);
  const [thoughtsOpen, setThoughtsOpen] = useState(false);
  const [wsStatus, setWsStatus] = useState<WsConnectionState>('disconnected');

  // Terminal WS hook — routes events to TerminalWorkspace (multi-tab)
  const terminalWsCallbacks = useMemo<DesktopWsCallbacks>(() => ({
    onTerminalCreated: (sessionName: string) => {
      setDashTermSession(sessionName);
      termWorkspaceRef.current?.onSessionCreated(sessionName);
    },
    onTerminalData: (sessionName: string, data: string) => {
      terminalRef.current?.writeToTerminal(data);
      termWorkspaceRef.current?.writeToTerminal(sessionName, data);
    },
    onTerminalError: (sessionName: string, error: string) => {
      terminalRef.current?.setTermError(error);
      termWorkspaceRef.current?.setTermError(sessionName, error);
    },
    onTerminalExited: (sessionName: string, _exitCode: number) => {
      terminalRef.current?.setTermExited(true);
      termWorkspaceRef.current?.setTermExited(sessionName);
    },
    onTerminalImage: (sessionName: string, imageB64: string, filename: string) => {
      termWorkspaceRef.current?.showImage(sessionName, imageB64, filename);
    },
  }), []);

  const {
    isConnected: termWsConnected,
    sendTerminalCreate,
    sendTerminalAttach,
    sendTerminalInput,
    sendTerminalResize,
    sendTerminalDetach,
  } = useDesktopWebSocket(undefined, terminalWsCallbacks);

  // Terminal auto-creation now handled by TerminalWorkspace component

  // ── Alert system ──
  const {
    alerts: activeAlerts,
    unreadCount,
    urgentCount,
    hasUnread,
    markRead,
    markAllRead,
    dismiss,
    dismissAll,
    updateAgents,
  } = useAlerts();

  // ── Cmd+K to toggle Thoughts Card ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setThoughtsOpen(v => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── Canvas tab state ──
  const [canvasTabs, setCanvasTabs] = useState<CanvasTab[]>([]);
  const [activeCanvasTabId, setActiveCanvasTabId] = useState<string | null>(null);

  const openCanvasTab = useCallback((tab: CanvasTab) => {
    console.log('[Canvas] openCanvasTab called:', tab.kind, tab.id);
    setCanvasTabs((prev) => {
      const existing = prev.find((t) => t.id === tab.id);
      if (existing) {
        console.log('[Canvas] tab already exists, just activating');
        return prev;
      }
      console.log('[Canvas] adding new tab, total:', prev.length + 1);
      return [...prev, tab];
    });
    setActiveCanvasTabId(tab.id);
  }, []);

  const closeCanvasTab = useCallback((tabId: string) => {
    setCanvasTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      // If we closed the active tab, activate the last remaining tab
      setActiveCanvasTabId((currentActive) => {
        if (currentActive === tabId) {
          return next.length > 0 ? next[next.length - 1].id : null;
        }
        return currentActive;
      });
      return next;
    });
  }, []);

  // ── Routing callbacks for AgentPanel ──
  const handleSelectSession = useCallback((sessionKey: string) => {
    // Agent clicks only change the chat session — terminal is independent
    setActiveSessionKey(sessionKey);
  }, []);

  const handleSelectIssue = useCallback((issueNumber: number, repo?: string) => {
    openCanvasTab({
      id: `issue:${issueNumber}${repo ? `:${repo}` : ''}`,
      kind: 'issue',
      label: `#${issueNumber}`,
      resourceId: String(issueNumber),
      meta: repo ? { repo } : undefined,
    });
  }, [openCanvasTab]);

  const handleSelectPR = useCallback((prNumber: number, repo?: string) => {
    openCanvasTab({
      id: `pr:${prNumber}${repo ? `:${repo}` : ''}`,
      kind: 'pr',
      label: `PR #${prNumber}`,
      resourceId: String(prNumber),
      meta: repo ? { repo } : undefined,
    });
  }, [openCanvasTab]);

  const handleExpandWorkspace = useCallback((workspace: string, repo: string | null) => {
    setActiveWorkspace(workspace);
    // Only open README tab if workspace actually has a README
    fetch(`/api/panel/readme?workspace=${encodeURIComponent(workspace)}`)
      .then(res => res.json())
      .then(data => {
        if (data.content) {
          openCanvasTab({
            id: `readme:${workspace}`,
            kind: 'readme',
            label: 'README',
            resourceId: workspace,
            meta: repo ? { repo } : undefined,
          });
        }
      })
      .catch(() => { /* no README, skip */ });
  }, [openCanvasTab]);

  const handleOpenGitLog = useCallback((workspace?: string) => {
    openCanvasTab({
      id: `git-log:${workspace ?? 'default'}`,
      kind: 'git-log',
      label: 'Git Log',
      resourceId: workspace ?? '',
    });
  }, [openCanvasTab]);

  const handleOpenMemory = useCallback(() => {
    setShowMemoryView(true);
  }, []);

  // ── Feed agent data to alert engine + search ──
  const handleAgentsUpdate = useCallback((agents: unknown[]) => {
    // AgentDetail from AgentPanel is compatible with AgentSummary for alert detection
    // (has id, name, status, context, approvalStatus, lastEventAt, sessionKey)
    updateAgents(agents as import('@/lib/fleet/types').AgentSummary[]);
    setAgentsJson(JSON.stringify(agents));
  }, [updateAgents]);

  // ── Alert action: navigate to agent session ──
  const handleAlertAction = useCallback((alert: import('@/lib/alerts/types').Alert) => {
    if (alert.sessionKey) {
      setActiveSessionKey(alert.sessionKey);
    }
    setAlertTrayOpen(false);
  }, []);

  const handleOpenDeploy = useCallback((project?: string) => {
    openCanvasTab({
      id: `deploy:${project ?? 'all'}`,
      kind: 'deploy',
      label: 'Deploys',
      resourceId: project ?? '',
      meta: project ? { project } : undefined,
    });
  }, [openCanvasTab]);

  const handleOpenCI = useCallback((repo: string) => {
    openCanvasTab({
      id: `ci:${repo}`,
      kind: 'ci',
      label: `CI`,
      resourceId: repo,
      meta: { repo },
    });
  }, [openCanvasTab]);

  const handleCreateIssue = useCallback((repo?: string) => {
    openCanvasTab({
      id: `new-issue:${repo ?? 'default'}:${Date.now()}`,
      kind: 'new-issue',
      label: 'New Issue',
      resourceId: 'new',
      meta: repo ? { repo } : undefined,
    });
  }, [openCanvasTab]);

  const handleSelectFile = useCallback((filePath: string, workspace?: string) => {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(ext);

    openCanvasTab({
      id: `${isImage ? 'image' : 'file'}:${filePath}${workspace ? `:${workspace}` : ''}`,
      kind: isImage ? 'image' : 'file',
      label: filePath.split('/').pop() ?? filePath,
      resourceId: filePath,
      meta: workspace ? { workspace } : undefined,
    });
  }, [openCanvasTab]);

  const handleSelectCommit = useCallback((hash: string) => {
    openCanvasTab({
      id: `commit:${hash}`,
      kind: 'commit',
      label: hash.slice(0, 7),
      resourceId: hash,
    });
  }, [openCanvasTab]);

  // ── Left drag handle ──
  const startLeftDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = leftWidth;
    const onMove = (ev: MouseEvent) => {
      setLeftWidth(Math.min(Math.max(startW + (ev.clientX - startX), 220), 500));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [leftWidth]);

  // ── Canvas vertical drag handle ──
  const centerRef = useRef<HTMLDivElement>(null);
  const startCanvasDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = canvasHeight;
    const onMove = (ev: MouseEvent) => {
      if (!centerRef.current) return;
      const rect = centerRef.current.getBoundingClientRect();
      const totalH = rect.height;
      const deltaY = startY - ev.clientY; // dragging up = bigger canvas
      const deltaPct = (deltaY / totalH) * 100;
      setCanvasHeight(Math.min(Math.max(startH + deltaPct, 20), 80));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [canvasHeight]);

  // ── Right drag handle ──
  const startRightDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = rightWidth;
    const onMove = (ev: MouseEvent) => {
      setRightWidth(Math.min(Math.max(startW + (startX - ev.clientX), 320), 600));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [rightWidth]);

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--t-bg)',
      color: 'var(--t-text)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif',
      overflow: 'hidden',
    }}>
      {/* ── Title Bar ── */}
      <TitleBar
        sidebarVisible={sidebarVisible}
        onToggleSidebar={() => setSidebarVisible(v => !v)}
        bottomPanelVisible={bottomPanelVisible}
        onToggleBottomPanel={() => setBottomPanelVisible(v => !v)}
        chatVisible={chatVisible}
        onToggleChat={() => setChatVisible(v => !v)}
        onSettingsClick={() => {
          setActiveNavSection('settings');
          setShowMemoryView(false);
        }}
        wsStatus={wsStatus}
        renderSearch={(onClose) => (
          <UniversalSearch
            variant="desktop"
            workspace={activeWorkspace}
            agentsJson={agentsJson}
            onSelectSession={(sessionKey) => { setActiveSessionKey(sessionKey); onClose(); }}
            onSelectIssue={(num) => { handleSelectIssue(num); onClose(); }}
            onSelectFile={(filePath, line) => {
              openCanvasTab({
                id: `file:${filePath}${activeWorkspace ? `:${activeWorkspace}` : ''}`,
                kind: 'file',
                label: filePath.split('/').pop() ?? filePath,
                resourceId: filePath,
                meta: {
                  ...(activeWorkspace ? { workspace: activeWorkspace } : {}),
                  ...(line ? { line: String(line) } : {}),
                },
              });
              onClose();
            }}
            onClose={onClose}
          />
        )}
      />

      {/* ── Session Timeline ── */}
      <SessionTimeline onExpand={() => {
        openCanvasTab({
          id: 'timeline:session',
          kind: 'timeline',
          label: 'Session Replay',
          resourceId: 'session',
        });
        setBottomPanelVisible(true);
      }} />

      {/* ── Main Layout (horizontal) ── */}
      <div style={{
        flex: 1,
        display: 'flex',
        overflow: 'hidden',
      }}>
      {/* ── Nav Rail + Left Panel ── */}
      {sidebarVisible && <NavRail
        activeSection={activeNavSection}
        onSectionChange={(section) => {
          setActiveNavSection(section);
          if (section === 'memory') setShowMemoryView(true);
          else setShowMemoryView(false);
        }}
        alertCount={unreadCount}
        onAlertClick={() => setAlertTrayOpen(!alertTrayOpen)}
        onSearchClick={() => setSearchOpen(true)}
        thoughtsOpen={thoughtsOpen}
        onThoughtsToggle={() => setThoughtsOpen(v => !v)}
      />}

      {/* ── Left: Agent Panel ── */}
      {sidebarVisible && <div style={{
        width: leftWidth,
        flexShrink: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        borderRight: '1px solid var(--t-divider)',
        position: 'relative',
      }}>
        <AgentPanel
          onSelectSession={handleSelectSession}
          onSelectIssue={handleSelectIssue}
          onSelectCommit={handleSelectCommit}
          onSelectPR={handleSelectPR}
          onExpandWorkspace={handleExpandWorkspace}
          onSelectFile={handleSelectFile}
          onOpenCI={handleOpenCI}
          onCreateIssue={handleCreateIssue}
          onOpenGitLog={handleOpenGitLog}
          onOpenDeploy={handleOpenDeploy}
          onOpenMemory={handleOpenMemory}
          onAgentsUpdate={handleAgentsUpdate}
        />
      </div>}

      {/* ── Left drag handle ── */}
      {sidebarVisible && <div
        onMouseDown={startLeftDrag}
        style={{
          width: 6,
          cursor: 'col-resize',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          zIndex: 10,
        }}
      >
        <div style={{
          width: 3,
          height: 40,
          borderRadius: 2,
          backgroundColor: 'var(--t-drag-handle)',
          transition: 'background-color 150ms',
        }} />
      </div>}

      {/* ── Center: Memory View OR Workspace (top) + Canvas (bottom) ── */}
      <div ref={centerRef} style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
      }}>
        {/* Full-screen Intent Canvas */}
        {activeNavSection === 'intent' && !showMemoryView && (
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <IntentCanvas />
          </div>
        )}

        {/* Full-screen Settings */}
        {activeNavSection === 'settings' && !showMemoryView && (
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <SettingsPage />
          </div>
        )}

        {/* Full-screen Analytics */}
        {activeNavSection === 'analytics' && !showMemoryView && (
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <AnalyticsPage />
          </div>
        )}

        {/* Full-screen Memory View */}
        {showMemoryView && (
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
            <button
              type="button"
              onClick={() => setShowMemoryView(false)}
              style={{
                position: 'absolute',
                bottom: 14,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 100,
                paddingTop: 6,
                paddingRight: 14,
                paddingBottom: 6,
                paddingLeft: 14,
                borderRadius: 8,
                border: '1px solid rgba(148,163,184,0.15)',
                background: 'rgba(10, 14, 26, 0.85)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                color: '#94a3b8',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}
            >
              ← Back to Workspace
            </button>
            <GraphExplorer3D />
          </div>
        )}

        {/* Terminal-first workspace — fills center column */}
        {!showMemoryView && activeNavSection !== 'intent' && activeNavSection !== 'settings' && activeNavSection !== 'analytics' && (
          <TerminalWorkspace
            ref={termWorkspaceRef}
            sendTerminalCreate={sendTerminalCreate}
            sendTerminalAttach={sendTerminalAttach}
            sendTerminalInput={sendTerminalInput}
            sendTerminalResize={sendTerminalResize}
            sendTerminalDetach={sendTerminalDetach}
            termWsConnected={termWsConnected}
          />
        )}

        {/* Canvas — only when tabs open, overlays below terminal */}
        {!showMemoryView && activeNavSection !== 'intent' && activeNavSection !== 'settings' && activeNavSection !== 'analytics' && canvasTabs.length > 0 && bottomPanelVisible && (
          <div style={{ flex: `0 0 ${canvasHeight}%`, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <Canvas
              tabs={canvasTabs}
              activeTabId={activeCanvasTabId}
              onSelectTab={setActiveCanvasTabId}
              onCloseTab={closeCanvasTab}
              onSelectCommit={handleSelectCommit}
            />
          </div>
        )}

        {/* REMOVED: Old workspace placeholder + terminal band + canvas layout */}
        {false && <div style={{
          flex: canvasTabs.length > 0 ? `0 0 ${100 - canvasHeight}%` : 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: 'var(--t-bg-gradient)',
        }}>
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            {!canvasTabs.length ? (
              <div style={{ textAlign: 'center', maxWidth: 480 }}>
                <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.12, color: 'var(--t-workspace-icon)' }}>◇</div>
                <h1 style={{
                  fontSize: 24,
                  fontWeight: 700,
                  letterSpacing: '-0.03em',
                  marginBottom: 8,
                  color: 'var(--t-text)',
                }}>
                  Workspace
                </h1>
                <p style={{
                  fontSize: 14,
                  color: 'var(--t-text-muted)',
                  lineHeight: 1.5,
                  letterSpacing: '-0.01em',
                }}>
                  Search files, explore code, and view diffs.
                </p>
              </div>
            ) : null}
          </div>
        </div>}
      </div>

      {/* ── Right drag handle ── */}
      {chatVisible && <div
        onMouseDown={startRightDrag}
        style={{
          width: 6,
          cursor: 'col-resize',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          zIndex: 10,
        }}
      >
        <div style={{
          width: 3,
          height: 40,
          borderRadius: 2,
          backgroundColor: 'var(--t-drag-handle)',
          transition: 'background-color 150ms',
        }} />
      </div>}

      {/* ── Right: Chat Sidebar ── */}
      {chatVisible && <div style={{
        width: rightWidth,
        flexShrink: 0,
        height: '100%',
        borderLeft: '1px solid var(--t-divider)',
      }}>
        <DesktopChat
          externalSessionKey={activeSessionKey}
          onOpenDiff={() => {
            openCanvasTab({
              id: 'diff:workspace',
              kind: 'diff',
              label: 'Diff',
              resourceId: 'workspace',
            });
          }}
          onOpenMermaid={(code) => {
            openCanvasTab({
              id: `mermaid:${code.slice(0, 40)}`,
              kind: 'mermaid',
              label: 'Diagram',
              resourceId: code,
            });
          }}
          onWsStatusChange={setWsStatus}
        />
      </div>}

      {/* ── Alert Toast (desktop only — urgent alerts slide in top-right) ── */}
      <AlertToast alerts={activeAlerts} onAction={handleAlertAction} />
      </div>{/* end main layout */}

      {/* ── Thoughts Card (floating overlay — sits on top of everything) ── */}
      <ThoughtsCard open={thoughtsOpen} onClose={() => setThoughtsOpen(false)} agents={JSON.parse(agentsJson)} />
    </div>
  );
}
