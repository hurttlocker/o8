'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWsConnectionState } from '../hooks/DesktopWebSocketContext';
import {
  readOrchestratorRuntimePreference,
  subscribeOrchestratorRuntimePreference,
} from '@/lib/orchestrator/preferences';
import { orchestratorRuntimeTone } from '@/lib/orchestrator/display';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { ThoughtsApprovals } from './ThoughtsApprovals';
import { ThoughtsChatPanel, type ThoughtsChatPanelChromeState, type ThoughtsChatPanelHandle } from './ThoughtsChatPanel';
import { ThoughtsHeader } from './ThoughtsHeader';
import { ThoughtsHistoryPanel, type ThoughtsHistoryPanelHandle } from './ThoughtsHistoryPanel';
import { HistoryIcon, MissionControlIcon } from './ThoughtsIcons';
import { ThoughtsMissionPanel, type ThoughtsMissionPanelHandle } from './ThoughtsMissionPanel';
import type { PendingApproval, ThoughtMode, ThoughtsCardProps } from './types';
import { buildAgentTargets } from './utils';

export function ThoughtsCard({
  open,
  onClose,
  agents = [],
  draftInjection,
  docked = false,
  missionState,
  workspaceTargets = [],
  onMissionStateChange,
  onLaunchPacket,
  onFocusPacket,
}: ThoughtsCardProps) {
  const [mode, setMode] = useState<ThoughtMode>('chat');
  const [missionControlOpen, setMissionControlOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [preferredRuntime, setPreferredRuntime] = useState<OrchestratorRuntime>(() => readOrchestratorRuntimePreference());
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({ w: 460, h: 0 });
  const [initialized, setInitialized] = useState(false);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [chatChromeState, setChatChromeState] = useState<ThoughtsChatPanelChromeState>({
    activeTargetLabel: orchestratorRuntimeTone(readOrchestratorRuntimePreference()).label,
    waitingForReply: false,
    hasMessages: false,
    threadId: null,
  });

  const approvalPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number; corner: string } | null>(null);
  const chatPanelRef = useRef<ThoughtsChatPanelHandle>(null);
  const missionPanelRef = useRef<ThoughtsMissionPanelHandle>(null);
  const historyPanelRef = useRef<ThoughtsHistoryPanelHandle>(null);

  const sessionTargets = useMemo(
    () => buildAgentTargets(agents, preferredRuntime),
    [agents, preferredRuntime],
  );
  const missionControlVisible = docked ? mode === 'orchestrate' : missionControlOpen;
  const thoughtsBodyBackground = 'linear-gradient(180deg, var(--t-glass-muted) 0%, rgba(0, 0, 0, 0) 100%)';
  const thoughtsElevatedSurface = 'var(--t-glass-elevated)';
  const thoughtsElevatedBorder = '1px solid var(--t-glass-border-strong)';
  const thoughtsElevatedShadow = 'var(--t-glass-shadow)';
  const thoughtsMutedGlass = 'var(--t-glass-muted-strong)';
  const floatingCompanionWidth = Math.min(size.w, 360);
  const floatingHistoryWidth = 200;
  const floatingShellWidth = minimized
    ? 220
    : ((!docked && historyOpen ? floatingHistoryWidth + 14 : 0) +
       size.w +
       (!docked && missionControlOpen ? floatingCompanionWidth + 14 : 0));

  useEffect(() => subscribeOrchestratorRuntimePreference(setPreferredRuntime), []);

  useEffect(() => {
    if (docked) return;
    if (open && !initialized) {
      const frame = window.requestAnimationFrame(() => {
        setPosition({
          x: Math.max(100, Math.round(window.innerWidth / 2 - 200)),
          y: Math.max(80, Math.round(window.innerHeight / 2 - 200)),
        });
        setInitialized(true);
      });
      setTimeout(() => chatPanelRef.current?.focusInput(), 100);
      return () => window.cancelAnimationFrame(frame);
    }
  }, [docked, open, initialized]);

  useEffect(() => {
    if (!open || docked) return;
    const timeout = window.setTimeout(() => {
      setMode('chat');
      setMissionControlOpen(false);
      setHistoryOpen(false);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [docked, open]);

  useEffect(() => {
    if (open && !minimized) {
      const focusTarget = missionControlVisible
        ? missionPanelRef.current
        : chatPanelRef.current;
      setTimeout(() => focusTarget?.focusInput(), 50);
    }
  }, [missionControlVisible, minimized, open]);

  useEffect(() => {
    if (!open || docked) return;

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [docked, onClose, open]);

  useEffect(() => {
    if (!open || !draftInjection?.id) return;
    const timeout = window.setTimeout(() => {
      setMode('chat');
      setMissionControlOpen(false);
      setMinimized(false);
      setTimeout(() => chatPanelRef.current?.focusInput(), 50);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [draftInjection?.id, open]);

  useEffect(() => {
    if (open && !docked && size.h === 0) {
      const frame = window.requestAnimationFrame(() => {
        setSize((current) => ({ ...current, h: 420 }));
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [docked, open, size.h]);

  useEffect(() => {
    if (!open || docked) return;
    const estimatedHeight = minimized ? 44 : (size.h > 0 ? size.h : 420);
    const frame = window.requestAnimationFrame(() => {
      setPosition((current) => ({
        x: Math.max(12, Math.min(current.x, Math.max(12, window.innerWidth - floatingShellWidth - 20))),
        y: Math.max(12, Math.min(current.y, Math.max(12, window.innerHeight - estimatedHeight - 20))),
      }));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [docked, floatingShellWidth, minimized, open, size.h]);

  const wsConnectionState = useWsConnectionState();
  const wsConnected = wsConnectionState === 'connected';

  useEffect(() => {
    if (!open) return;

    const pollApprovals = async () => {
      try {
        const res = await fetch('/api/panel/approvals');
        if (res.ok) {
          const data = await res.json();
          setApprovals(data.approvals || []);
        }
      } catch {
        // silent
      }
    };

    // Fetch immediately on open AND on WS reconnect (not just every 15s)
    pollApprovals();
    if (approvalPollRef.current) clearInterval(approvalPollRef.current);
    approvalPollRef.current = setInterval(pollApprovals, 15_000);

    return () => {
      if (approvalPollRef.current) clearInterval(approvalPollRef.current);
    };
  }, [open, wsConnected]);

  const handleApprovalResolve = useCallback(async (id: string, action: 'approve' | 'reject') => {
    setResolvingId(id);
    try {
      const res = await fetch('/api/panel/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id }),
      });
      if (res.ok) {
        setApprovals((current) => current.filter((approval) => approval.id !== id));
      }
    } catch {
      // silent
    }
    setResolvingId(null);
  }, []);

  const handleSelectThread = useCallback((tabId: string) => {
    chatPanelRef.current?.loadThread(tabId);
    // Switch to chat mode and close history in docked mode
    if (docked) setMode('chat');
    else setHistoryOpen(false);
  }, [docked]);

  const handleDragStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startY: event.clientY, origX: position.x, origY: position.y };

    const handleMove = (nextEvent: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = nextEvent.clientX - dragRef.current.startX;
      const dy = nextEvent.clientY - dragRef.current.startY;
      setPosition({
        x: Math.max(0, Math.min(window.innerWidth - floatingShellWidth - 20, dragRef.current.origX + dx)),
        y: Math.max(0, Math.min(window.innerHeight - 100, dragRef.current.origY + dy)),
      });
    };
    const handleUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [floatingShellWidth, position]);

  const handleResizeStart = useCallback((corner: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const currentH = cardRef.current?.getBoundingClientRect().height || 300;
    resizeRef.current = { startX: event.clientX, startY: event.clientY, origW: size.w, origH: currentH, corner };

    const handleMove = (nextEvent: MouseEvent) => {
      if (!resizeRef.current) return;
      const dx = nextEvent.clientX - resizeRef.current.startX;
      const dy = nextEvent.clientY - resizeRef.current.startY;
      const c = resizeRef.current.corner;

      let newW = resizeRef.current.origW;
      let newH = resizeRef.current.origH;

      if (c.includes('e')) newW = Math.max(320, Math.min(800, resizeRef.current.origW + dx));
      if (c.includes('w')) {
        newW = Math.max(320, Math.min(800, resizeRef.current.origW - dx));
        setPosition((current) => ({ ...current, x: Math.max(0, current.x + dx) }));
      }
      if (c.includes('s')) newH = Math.max(200, Math.min(700, resizeRef.current.origH + dy));

      setSize({ w: newW, h: newH });
    };

    const handleUp = () => {
      resizeRef.current = null;
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [size.w]);

  if (!open && !docked) return null;

  return (
    <>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
        @keyframes llmFadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes llmDot {
          0%, 80%, 100% { transform: scale(0.7); opacity: 0.45; }
          40% { transform: scale(1); opacity: 1; }
        }
        @keyframes compactionProgress {
          0% { width: 10%; }
          50% { width: 70%; }
          100% { width: 95%; }
        }
        .thoughts-scroll::-webkit-scrollbar { display: none; }
        .thoughts-scroll { scrollbar-width: none; }
        .thoughts-orchestrate-input::placeholder {
          font-style: italic;
          color: var(--t-text-faint, #c0c8d4);
        }
      `}</style>

      <div
        ref={cardRef}
        style={{
          position: docked ? 'relative' : 'fixed',
          left: docked ? undefined : position.x,
          top: docked ? undefined : position.y,
          width: docked ? '100%' : floatingShellWidth,
          height: docked ? '100%' : (minimized ? 'auto' : (size.h > 0 ? size.h : 'auto')),
          zIndex: docked ? 1 : 10001,
          borderRadius: docked ? 14 : (minimized ? 12 : 18),
          background: 'var(--t-panel-translucent)',
          backdropFilter: 'blur(50px) saturate(180%)',
          WebkitBackdropFilter: 'blur(50px) saturate(180%)',
          border: '1px solid var(--t-panel-border)',
          boxShadow: docked ? 'none' : 'var(--t-panel-shadow)',
          overflow: docked ? 'hidden' : 'visible',
          display: 'flex',
          flexDirection: 'column',
          flex: docked ? 1 : undefined,
          minHeight: 0,
          transition: 'width 220ms cubic-bezier(0.22, 1, 0.36, 1), border-radius 220ms ease',
          fontFamily: '-apple-system, system-ui, BlinkMacSystemFont, sans-serif',
        }}
      >
        <ThoughtsHeader
          docked={docked}
          minimized={minimized}
          title={chatChromeState.hasMessages ? chatChromeState.activeTargetLabel : 'Thoughts'}
          approvalsCount={approvals.length}
          waitingForReply={chatChromeState.waitingForReply}
          showReset={chatChromeState.hasMessages}
          onReset={() => chatPanelRef.current?.reset()}
          onToggleMinimized={() => setMinimized((value) => !value)}
          onClose={onClose}
          onMouseDown={docked ? undefined : handleDragStart}
        />

        {!minimized && (
          <div style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            borderRadius: docked ? '0 0 14px 14px' : '0 0 18px 18px',
          }}>
            <ThoughtsApprovals
              approvals={approvals}
              resolvingId={resolvingId}
              onResolve={handleApprovalResolve}
            />

            {docked ? (
              <>
                <div style={{
                  display: 'flex',
                  gap: 8,
                  padding: '10px 12px 0',
                  flexShrink: 0,
                }}>
                  {([
                    { key: 'orchestrate' as const, label: 'Mission Control' },
                    { key: 'chat' as const, label: 'Live Chat' },
                    { key: 'history' as const, label: 'History' },
                  ]).map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      onClick={() => setMode(option.key)}
                      style={{
                        border: mode === option.key ? '1px solid var(--t-accent-border)' : '1px solid var(--t-panel-border)',
                        background: mode === option.key ? 'var(--t-accent-soft)' : 'var(--t-panel)',
                        color: mode === option.key ? 'var(--t-text)' : 'var(--t-text-secondary)',
                        padding: '6px 10px',
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: 'pointer',
                        transition: 'background 140ms ease, border-color 140ms ease, color 140ms ease',
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {mode === 'history' ? (
                  <ThoughtsHistoryPanel
                    ref={historyPanelRef}
                    visible={mode === 'history'}
                    activeThreadId={chatChromeState.threadId}
                    onSelectThread={handleSelectThread}
                    thoughtsBodyBackground={thoughtsBodyBackground}
                    thoughtsElevatedSurface={thoughtsElevatedSurface}
                    thoughtsElevatedBorder={thoughtsElevatedBorder}
                    thoughtsElevatedShadow={thoughtsElevatedShadow}
                  />
                ) : mode === 'orchestrate' ? (
                  <ThoughtsMissionPanel
                    ref={missionPanelRef}
                    open={open}
                    visible={missionControlVisible}
                    missionState={missionState}
                    workspaceTargets={workspaceTargets}
                    preferredRuntime={preferredRuntime}
                    sessionTargets={sessionTargets}
                    thoughtsBodyBackground={thoughtsBodyBackground}
                    thoughtsElevatedSurface={thoughtsElevatedSurface}
                    thoughtsElevatedBorder={thoughtsElevatedBorder}
                    thoughtsElevatedShadow={thoughtsElevatedShadow}
                    thoughtsMutedGlass={thoughtsMutedGlass}
                    onMissionStateChange={onMissionStateChange}
                    onLaunchPacket={onLaunchPacket}
                    onFocusPacket={onFocusPacket}
                  />
                ) : (
                  <ThoughtsChatPanel
                    ref={chatPanelRef}
                    open={open}
                    draftInjection={draftInjection}
                    agents={agents}
                    preferredRuntime={preferredRuntime}
                    sessionTargets={sessionTargets}
                    repoPath={workspaceTargets[0]?.localPath ?? null}
                    thoughtsBodyBackground={thoughtsBodyBackground}
                    thoughtsElevatedSurface={thoughtsElevatedSurface}
                    thoughtsElevatedBorder={thoughtsElevatedBorder}
                    thoughtsElevatedShadow={thoughtsElevatedShadow}
                    thoughtsMutedGlass={thoughtsMutedGlass}
                    onChromeChange={setChatChromeState}
                  />
                )}
              </>
            ) : (
              <div style={{
                flex: 1,
                display: 'flex',
                alignItems: 'stretch',
                minHeight: 0,
                overflow: 'hidden',
              }}>
                <div style={{
                  width: historyOpen ? floatingHistoryWidth + 14 : 0,
                  opacity: historyOpen ? 1 : 0,
                  overflow: 'hidden',
                  pointerEvents: historyOpen ? 'auto' : 'none',
                  transition: 'width 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease',
                  flexShrink: 0,
                }}>
                  <div style={{
                    width: floatingHistoryWidth,
                    height: '100%',
                    marginRight: 14,
                    borderRight: '1px solid var(--t-divider-subtle)',
                    background: 'linear-gradient(180deg, rgba(148, 163, 184, 0.04) 0%, rgba(148, 163, 184, 0.01) 100%)',
                    display: 'flex',
                    flexDirection: 'column',
                    minWidth: 0,
                    minHeight: 0,
                  }}>
                    <ThoughtsHistoryPanel
                      ref={historyPanelRef}
                      visible={historyOpen}
                      activeThreadId={chatChromeState.threadId}
                      onSelectThread={handleSelectThread}
                      thoughtsBodyBackground={thoughtsBodyBackground}
                      thoughtsElevatedSurface={thoughtsElevatedSurface}
                      thoughtsElevatedBorder={thoughtsElevatedBorder}
                      thoughtsElevatedShadow={thoughtsElevatedShadow}
                    />
                  </div>
                </div>
                <div style={{ flex: `0 0 ${size.w}px`, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <ThoughtsChatPanel
                    ref={chatPanelRef}
                    open={open}
                    draftInjection={draftInjection}
                    agents={agents}
                    preferredRuntime={preferredRuntime}
                    sessionTargets={sessionTargets}
                    repoPath={workspaceTargets[0]?.localPath ?? null}
                    thoughtsBodyBackground={thoughtsBodyBackground}
                    thoughtsElevatedSurface={thoughtsElevatedSurface}
                    thoughtsElevatedBorder={thoughtsElevatedBorder}
                    thoughtsElevatedShadow={thoughtsElevatedShadow}
                    thoughtsMutedGlass={thoughtsMutedGlass}
                    onChromeChange={setChatChromeState}
                  />
                </div>
                <div style={{
                  width: missionControlOpen ? floatingCompanionWidth + 14 : 0,
                  opacity: missionControlOpen ? 1 : 0,
                  overflow: 'hidden',
                  pointerEvents: missionControlOpen ? 'auto' : 'none',
                  transition: 'width 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease',
                  flexShrink: 0,
                }}>
                  <div style={{
                    width: floatingCompanionWidth,
                    height: '100%',
                    marginLeft: 14,
                    borderLeft: '1px solid var(--t-divider-subtle)',
                    background: 'linear-gradient(180deg, rgba(148, 163, 184, 0.04) 0%, rgba(148, 163, 184, 0.01) 100%)',
                    display: 'flex',
                    flexDirection: 'column',
                    minWidth: 0,
                    minHeight: 0,
                  }}>
                    <ThoughtsMissionPanel
                      ref={missionPanelRef}
                      open={open}
                      visible={missionControlVisible}
                      missionState={missionState}
                      workspaceTargets={workspaceTargets}
                      preferredRuntime={preferredRuntime}
                      sessionTargets={sessionTargets}
                      thoughtsBodyBackground={thoughtsBodyBackground}
                      thoughtsElevatedSurface={thoughtsElevatedSurface}
                      thoughtsElevatedBorder={thoughtsElevatedBorder}
                      thoughtsElevatedShadow={thoughtsElevatedShadow}
                      thoughtsMutedGlass={thoughtsMutedGlass}
                      onMissionStateChange={onMissionStateChange}
                      onLaunchPacket={onLaunchPacket}
                      onFocusPacket={onFocusPacket}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {!docked && !minimized && (
          <button
            type="button"
            onClick={() => {
              setHistoryOpen((value) => !value);
              setTimeout(() => historyPanelRef.current?.refresh(), 0);
            }}
            title={historyOpen ? 'Hide History' : 'Show History'}
            style={{
              position: 'absolute',
              top: 86,
              left: -29,
              width: 30,
              height: 56,
              borderRadius: '14px 0 0 14px',
              border: '1px solid var(--t-panel-border)',
              borderRight: 'none',
              background: historyOpen ? 'var(--t-accent-soft)' : 'var(--t-panel-translucent)',
              backdropFilter: 'blur(24px) saturate(180%)',
              WebkitBackdropFilter: 'blur(24px) saturate(180%)',
              boxShadow: 'var(--t-panel-shadow)',
              color: historyOpen ? '#2563eb' : 'var(--t-text-secondary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              zIndex: 4,
              transition: 'background 180ms ease, color 180ms ease, transform 180ms ease',
            }}
          >
            <HistoryIcon />
          </button>
        )}

        {!docked && !minimized && (
          <button
            type="button"
            onClick={() => {
              setMissionControlOpen((value) => {
                const next = !value;
                setMode(next ? 'orchestrate' : 'chat');
                return next;
              });
            }}
            title={missionControlOpen ? 'Hide Mission Control' : 'Show Mission Control'}
            style={{
              position: 'absolute',
              top: 86,
              right: -29,
              width: 30,
              height: 56,
              borderRadius: '0 14px 14px 0',
              border: '1px solid var(--t-panel-border)',
              borderLeft: 'none',
              background: missionControlOpen ? 'var(--t-accent-soft)' : 'var(--t-panel-translucent)',
              backdropFilter: 'blur(24px) saturate(180%)',
              WebkitBackdropFilter: 'blur(24px) saturate(180%)',
              boxShadow: 'var(--t-panel-shadow)',
              color: missionControlOpen ? '#2563eb' : 'var(--t-text-secondary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              zIndex: 4,
              transition: 'background 180ms ease, color 180ms ease, transform 180ms ease',
            }}
          >
            <MissionControlIcon />
          </button>
        )}

        {!minimized && !docked && (
          <>
            <div onMouseDown={handleResizeStart('e')} style={{
              position: 'absolute', top: 20, right: -3, bottom: 20, width: 6,
              cursor: 'ew-resize', zIndex: 2,
            }} />
            <div onMouseDown={handleResizeStart('s')} style={{
              position: 'absolute', bottom: -3, left: 20, right: 20, height: 6,
              cursor: 'ns-resize', zIndex: 2,
            }} />
            <div onMouseDown={handleResizeStart('se')} style={{
              position: 'absolute', bottom: -3, right: -3, width: 14, height: 14,
              cursor: 'nwse-resize', zIndex: 3,
            }} />
            <div onMouseDown={handleResizeStart('sw')} style={{
              position: 'absolute', bottom: -3, left: -3, width: 14, height: 14,
              cursor: 'nesw-resize', zIndex: 3,
            }} />
          </>
        )}
      </div>
    </>
  );
}
