'use client';

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DEFAULT_TIMELINE_REPO,
  DRILL_LEFT_GUTTER,
  DRILL_MAX_HEIGHT,
  DRILL_MAX_WIDTH,
  DRILL_MIN_HEIGHT,
  DRILL_MIN_WIDTH,
  DRILL_TOP_GUTTER,
} from './constants';
import { formatDuration, formatTime } from './helpers';
import type { TimelineSegment } from './types';

const CortexTaskBoard = lazy(() => import('../CortexTaskBoard').then(m => ({ default: m.CortexTaskBoard })));

interface AgentSession {
  id: string;
  label: string;
  model: string;
  startTime: string;
  duration: string;
  messages: number;
  status: string;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  active?: boolean;
}

interface GHIssue {
  number: number;
  title: string;
  labels: (string | { name: string; color?: string })[];
  state: string;
}

interface TimelineDrilldownProps {
  segments: TimelineSegment[];
  totalSpan: number;
  repoPath?: string | null;
  repoName?: string | null;
  onClose: () => void;
}

export function TimelineDrilldown({
  segments,
  totalSpan,
  repoPath,
  repoName,
  onClose,
}: TimelineDrilldownProps) {
  const [drillPos, setDrillPos] = useState({ x: DRILL_LEFT_GUTTER, y: DRILL_TOP_GUTTER });
  const [drillSize, setDrillSize] = useState({ w: 520, h: 400 });
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; originW: number; originH: number } | null>(null);

  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [sessionPanelPos, setSessionPanelPos] = useState({ x: 0, y: 0 });
  const sessionDragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const agentCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const sessionPanelRef = useRef<HTMLDivElement>(null);
  const [, forceUpdate] = useState(0);
  const tickDrag = useCallback(() => forceUpdate(n => n + 1), []);

  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [agentTotalCost, setAgentTotalCost] = useState<number>(0);

  const [issuesPanelOpen, setIssuesPanelOpen] = useState(false);
  const [issuesPanelPos, setIssuesPanelPos] = useState({ x: 0, y: 0 });
  const issuesDragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const issuesPanelRef = useRef<HTMLDivElement>(null);
  const [ghIssues, setGhIssues] = useState<GHIssue[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [assigningIssue, setAssigningIssue] = useState<number | null>(null);

  const clampDrillWidth = useCallback((width: number) => {
    if (typeof window === 'undefined') return Math.min(Math.max(width, DRILL_MIN_WIDTH), DRILL_MAX_WIDTH);
    const sessionPanelAllowance = 380 + 32 + 24;
    const maxByViewport = Math.max(
      DRILL_MIN_WIDTH,
      Math.min(DRILL_MAX_WIDTH, window.innerWidth - DRILL_LEFT_GUTTER - sessionPanelAllowance),
    );
    return Math.min(Math.max(width, DRILL_MIN_WIDTH), maxByViewport);
  }, []);

  const clampDrillHeight = useCallback((height: number) => {
    if (typeof window === 'undefined') return Math.min(Math.max(height, DRILL_MIN_HEIGHT), DRILL_MAX_HEIGHT);
    const maxByViewport = Math.max(DRILL_MIN_HEIGHT, Math.min(DRILL_MAX_HEIGHT, window.innerHeight - DRILL_TOP_GUTTER - 48));
    return Math.min(Math.max(height, DRILL_MIN_HEIGHT), maxByViewport);
  }, []);

  useEffect(() => {
    setDrillSize((current) => ({
      w: clampDrillWidth(current.w),
      h: clampDrillHeight(current.h),
    }));
  }, [clampDrillHeight, clampDrillWidth]);

  const handleDrillResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originW: drillSize.w,
      originH: drillSize.h,
    };
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      const nextW = clampDrillWidth(resizeRef.current.originW + (ev.clientX - resizeRef.current.startX));
      const nextH = clampDrillHeight(resizeRef.current.originH + (ev.clientY - resizeRef.current.startY));
      setDrillSize({ w: nextW, h: nextH });
      if (selectedAgent) {
        setSessionPanelPos((current) => ({ ...current, x: drillPos.x + nextW + 32 }));
        if (issuesPanelOpen) {
          setIssuesPanelPos((current) => ({ ...current, x: drillPos.x + nextW + 32 + 400 }));
        }
      }
      tickDrag();
    };
    const onUp = () => {
      resizeRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [clampDrillHeight, clampDrillWidth, drillPos.x, drillSize.h, drillSize.w, issuesPanelOpen, selectedAgent, tickDrag]);

  const handleAgentClick = useCallback((agentName: string) => {
    if (selectedAgent === agentName) {
      setSelectedAgent(null);
      return;
    }
    const cardEl = agentCardRefs.current.get(agentName);
    const cardRect = cardEl?.getBoundingClientRect();
    setSessionPanelPos({
      x: drillPos.x + drillSize.w + 32,
      y: cardRect ? cardRect.top - 20 : drillPos.y,
    });
    setSelectedAgent(agentName);

    setSessionsLoading(true);
    setAgentSessions([]);
    setAgentTotalCost(0);

    fetch(`/api/panel/session-costs?agent=${encodeURIComponent(agentName)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.sessions?.length > 0) {
          const sessions: AgentSession[] = data.sessions.map((s: { id: string; model: string; messages: number; cost: number; inputTokens: number; outputTokens: number; cacheTokens: number; active?: boolean }) => ({
            id: s.id,
            label: s.id.slice(0, 8),
            model: s.model || '',
            startTime: '',
            duration: '',
            messages: s.messages,
            status: s.active ? 'active' : 'idle',
            active: s.active,
            cost: s.cost,
            inputTokens: s.inputTokens,
            outputTokens: s.outputTokens,
            cacheTokens: s.cacheTokens,
          }));
          setAgentSessions(sessions);
          setAgentTotalCost(data.byAgent?.[agentName]?.cost || 0);
        } else {
          const agentSegs = segments.filter(s => s.agent === agentName);
          if (agentSegs.length > 0) {
            const firstSeg = agentSegs[0];
            const totalMin = agentSegs.reduce((s, x) => s + x.durationMin, 0);
            setAgentSessions([{
              id: `derived-${agentName}`,
              label: `${agentName} — Today`,
              model: '',
              startTime: formatTime(firstSeg.startMin),
              duration: formatDuration(totalMin),
              messages: agentSegs.length,
              status: 'active',
            }]);
          }
        }
      })
      .catch(() => {})
      .finally(() => setSessionsLoading(false));
  }, [selectedAgent, drillPos, drillSize, segments]);

  const handleSessionDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    sessionDragRef.current = { startX: e.clientX, startY: e.clientY, originX: sessionPanelPos.x, originY: sessionPanelPos.y };
    const onMove = (ev: MouseEvent) => {
      if (!sessionDragRef.current) return;
      setSessionPanelPos({
        x: sessionDragRef.current.originX + (ev.clientX - sessionDragRef.current.startX),
        y: sessionDragRef.current.originY + (ev.clientY - sessionDragRef.current.startY),
      });
      tickDrag();
    };
    const onUp = () => {
      sessionDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [sessionPanelPos, tickDrag]);

  const agentRepoMap: Record<string, string> = {
    Main: DEFAULT_TIMELINE_REPO,
    'Agent 2': DEFAULT_TIMELINE_REPO,
    'Agent 3': DEFAULT_TIMELINE_REPO,
    codex: DEFAULT_TIMELINE_REPO,
    Mister: DEFAULT_TIMELINE_REPO,
    Niot: 'hurttlocker/cortex',
    Hawk: 'hurttlocker/cortex',
  };

  const resolveAgentRepo = useCallback((agentName: string | null) => {
    if (!agentName) return DEFAULT_TIMELINE_REPO;
    return agentRepoMap[agentName] || DEFAULT_TIMELINE_REPO;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOpenIssues = useCallback(() => {
    setIssuesPanelPos({
      x: sessionPanelPos.x + 392,
      y: sessionPanelPos.y,
    });
    setIssuesPanelOpen(true);
    setIssuesLoading(true);
    const repo = resolveAgentRepo(selectedAgent);
    fetch(`/api/panel/issues?repo=${encodeURIComponent(repo)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.issues) {
          setGhIssues(data.issues.filter((i: GHIssue) => i.state.toLowerCase() === 'open').slice(0, 20));
        }
      })
      .catch(() => {})
      .finally(() => setIssuesLoading(false));
  }, [resolveAgentRepo, selectedAgent, sessionPanelPos]);

  const handleIssuesDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    issuesDragRef.current = { startX: e.clientX, startY: e.clientY, originX: issuesPanelPos.x, originY: issuesPanelPos.y };
    const onMove = (ev: MouseEvent) => {
      if (!issuesDragRef.current) return;
      setIssuesPanelPos({
        x: issuesDragRef.current.originX + (ev.clientX - issuesDragRef.current.startX),
        y: issuesDragRef.current.originY + (ev.clientY - issuesDragRef.current.startY),
      });
      tickDrag();
    };
    const onUp = () => {
      issuesDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [issuesPanelPos, tickDrag]);

  const handleAssignIssue = useCallback(async (issueNumber: number) => {
    if (!selectedAgent) return;
    setAssigningIssue(issueNumber);
    const repo = resolveAgentRepo(selectedAgent);
    try {
      await fetch('/api/panel/assign-issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue: issueNumber, agent: selectedAgent, repo }),
      });
      setGhIssues(prev => prev.filter(i => i.number !== issueNumber));
    } catch { /* silent */ }
    finally { setAssigningIssue(null); }
  }, [resolveAgentRepo, selectedAgent]);

  useEffect(() => {
    if (!selectedAgent) setIssuesPanelOpen(false);
  }, [selectedAgent]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      <div style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'linear-gradient(180deg, rgba(255,255,255,0.14), rgba(239,246,255,0.1))',
        backdropFilter: 'blur(28px) saturate(1.42)',
        WebkitBackdropFilter: 'blur(28px) saturate(1.42)',
        display: 'flex',
        flexDirection: 'column',
        animation: 'drillFadeIn 180ms cubic-bezier(0.32, 0.72, 0, 1)',
      }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '18px 22px 14px',
            userSelect: 'none',
            borderBottom: '1px solid rgba(255, 255, 255, 0.18)',
            background: 'linear-gradient(180deg, rgba(255,255,255,0.12), rgba(255,255,255,0.04))',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.02em' }}>
              Cortex Board
            </span>
            <span style={{ fontSize: 11, color: 'var(--t-text-muted)', fontWeight: 500 }}>
              Timeline drilldown · {formatDuration(totalSpan)}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 24, height: 24, borderRadius: 12,
              border: 'none', background: 'rgba(255,255,255,0.12)',
              color: 'var(--t-text-muted)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, fontWeight: 600, lineHeight: 1,
              transition: 'background 120ms',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.2)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
          >
            ×
          </button>
        </div>

        <div style={{
          padding: '18px 22px 22px',
          overflow: 'hidden',
          flex: 1,
          minHeight: 0,
        }}>
          <Suspense fallback={null}>
            <CortexTaskBoard
              repoPath={repoPath}
              repoName={repoName}
            />
          </Suspense>
        </div>
      </div>

      {selectedAgent && (() => {
        const cardEl = agentCardRefs.current.get(selectedAgent);
        if (!cardEl) return null;
        const cardRect = cardEl.getBoundingClientRect();
        const panelX = sessionPanelPos.x;
        const panelY = sessionPanelPos.y;

        const x1 = cardRect.right + 2;
        const y1 = cardRect.top + cardRect.height / 2;
        const x2 = panelX;
        const y2 = panelY + 30;
        const cpOffset = Math.min(80, Math.abs(x2 - x1) * 0.4);

        return (
          <svg
            style={{
              position: 'fixed', inset: 0,
              width: '100vw', height: '100vh',
              pointerEvents: 'none', zIndex: 9998,
            }}
          >
            <defs>
              <linearGradient id="connectorGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#2563eb" stopOpacity="0.6" />
                <stop offset="100%" stopColor="#2563eb" stopOpacity="0.3" />
              </linearGradient>
            </defs>
            <path
              d={`M ${x1} ${y1} C ${x1 + cpOffset} ${y1}, ${x2 - cpOffset} ${y2}, ${x2} ${y2}`}
              fill="none"
              stroke="rgba(37, 99, 235, 0.15)"
              strokeWidth="6"
              strokeLinecap="round"
            />
            <path
              d={`M ${x1} ${y1} C ${x1 + cpOffset} ${y1}, ${x2 - cpOffset} ${y2}, ${x2} ${y2}`}
              fill="none"
              stroke="url(#connectorGrad)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <circle cx={x1} cy={y1} r="3" fill="#2563eb" opacity="0.5" />
            <circle cx={x2} cy={y2} r="3" fill="#2563eb" opacity="0.5" />
          </svg>
        );
      })()}

      {selectedAgent && (
        <div
          ref={sessionPanelRef}
          style={{
            position: 'fixed',
            left: sessionPanelPos.x,
            top: sessionPanelPos.y,
            width: 380,
            maxHeight: 420,
            zIndex: 9999,
            background: 'rgba(255, 255, 255, 0.18)',
            backdropFilter: 'blur(80px) saturate(2.2)',
            WebkitBackdropFilter: 'blur(80px) saturate(2.2)',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: 16,
            boxShadow: '0 24px 80px rgba(0, 0, 0, 0.08), 0 8px 32px rgba(0, 0, 0, 0.04), inset 0 0.5px 0 rgba(255, 255, 255, 0.4), inset 0 -0.5px 0 rgba(255, 255, 255, 0.1)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            animation: 'drillFadeIn 180ms cubic-bezier(0.32, 0.72, 0, 1)',
          }}
        >
          <div
            onMouseDown={handleSessionDragStart}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 14px 10px',
              cursor: 'grab',
              userSelect: 'none',
              borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 20, height: 20, borderRadius: 6,
                background: 'rgba(37, 99, 235, 0.15)',
                border: '1px solid rgba(37, 99, 235, 0.25)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10, fontWeight: 700, color: '#2563eb',
              }}>
                {selectedAgent[0]}
              </div>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.02em' }}>
                {selectedAgent}
              </span>
              {agentTotalCost > 0 && (
                <span style={{
                  fontSize: 11, fontWeight: 700, color: '#22c55e',
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                  background: 'rgba(34, 197, 94, 0.1)',
                  padding: '2px 6px',
                  borderRadius: 6,
                }}>
                  ${agentTotalCost.toFixed(2)}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                type="button"
                onClick={handleOpenIssues}
                style={{
                  height: 22, borderRadius: 6,
                  border: 'none',
                  background: issuesPanelOpen ? 'rgba(37, 99, 235, 0.2)' : 'rgba(255,255,255,0.12)',
                  color: issuesPanelOpen ? '#2563eb' : 'var(--t-text-muted)',
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '0 8px',
                  fontSize: 10, fontWeight: 600, letterSpacing: '-0.01em',
                  transition: 'all 120ms',
                }}
                onMouseEnter={(e) => { if (!issuesPanelOpen) e.currentTarget.style.background = 'rgba(255,255,255,0.2)'; }}
                onMouseLeave={(e) => { if (!issuesPanelOpen) e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
              >
                <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" />
                </svg>
                Assign
              </button>
              <button
                type="button"
                onClick={() => setSelectedAgent(null)}
                aria-label="Close"
                style={{
                  width: 22, height: 22, borderRadius: 11,
                  border: 'none', background: 'rgba(255,255,255,0.12)',
                  color: 'var(--t-text-muted)', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 13, fontWeight: 600, lineHeight: 1,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.2)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
              >
                ×
              </button>
            </div>
          </div>

          <div style={{
            padding: '10px 14px 14px',
            overflowY: 'auto',
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}>
            {sessionsLoading && (
              <div style={{ textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 11, padding: 16 }}>
                Loading sessions…
              </div>
            )}

            {!sessionsLoading && agentSessions.map((session) => (
              <div
                key={session.id}
                style={{
                  background: session.active
                    ? 'linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(52,211,153,0.06) 100%)'
                    : 'rgba(255, 255, 255, 0.1)',
                  border: session.active
                    ? '1px solid rgba(52, 211, 153, 0.25)'
                    : '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: 10,
                  padding: 10,
                  cursor: 'pointer',
                  transition: 'all 120ms ease',
                  animation: session.active ? 'sessionPulse 3s ease-in-out infinite' : 'none',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.18)';
                  e.currentTarget.style.border = '1px solid rgba(37, 99, 235, 0.2)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                  e.currentTarget.style.border = '1px solid rgba(255, 255, 255, 0.12)';
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
                    {session.label}
                  </span>
                  <div style={{
                    width: 6, height: 6, borderRadius: 3,
                    background: session.status === 'active' ? '#34c759' : '#9ca3af',
                  }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {session.startTime && (
                    <>
                      <span style={{
                        fontSize: 10, color: 'var(--t-text-muted)',
                        fontFamily: '"SF Mono", ui-monospace, monospace',
                      }}>
                        {session.startTime}
                      </span>
                      <span style={{ fontSize: 9, color: 'var(--t-text-faint)' }}>·</span>
                    </>
                  )}
                  {session.duration && (
                    <>
                      <span style={{ fontSize: 10, color: 'var(--t-text-muted)', fontWeight: 600 }}>
                        {session.duration}
                      </span>
                      <span style={{ fontSize: 9, color: 'var(--t-text-faint)' }}>·</span>
                    </>
                  )}
                  <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>
                    {session.messages} msg{session.messages !== 1 ? 's' : ''}
                  </span>
                  {session.model && (
                    <>
                      <span style={{ fontSize: 9, color: 'var(--t-text-faint)' }}>·</span>
                      <span style={{ fontSize: 10, color: 'var(--t-text-secondary)' }}>
                        {session.model}
                      </span>
                    </>
                  )}
                </div>
                {session.cost != null && session.cost > 0 && (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    marginTop: 6, flexWrap: 'wrap',
                  }}>
                    <span style={{
                      fontSize: 11, fontWeight: 700, color: '#22c55e',
                      fontFamily: '"SF Mono", ui-monospace, monospace',
                    }}>
                      ${session.cost.toFixed(3)}
                    </span>
                    {(session.outputTokens ?? 0) > 0 && (
                      <>
                        <span style={{ fontSize: 9, color: 'var(--t-text-faint)' }}>·</span>
                        <span style={{ fontSize: 10, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                          {((session.outputTokens ?? 0) / 1000).toFixed(1)}k out
                        </span>
                      </>
                    )}
                    {(session.cacheTokens ?? 0) > 0 && (
                      <>
                        <span style={{ fontSize: 9, color: 'var(--t-text-faint)' }}>·</span>
                        <span style={{ fontSize: 10, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                          {((session.cacheTokens ?? 0) / 1_000_000).toFixed(1)}M cache
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}

            {!sessionsLoading && agentSessions.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 11, padding: 16 }}>
                No sessions found
              </div>
            )}
          </div>
        </div>
      )}

      {issuesPanelOpen && selectedAgent && (() => {
        const x1 = sessionPanelPos.x + 380 + 2;
        const y1 = sessionPanelPos.y + 30;
        const x2 = issuesPanelPos.x;
        const y2 = issuesPanelPos.y + 30;
        const cpOffset = Math.min(80, Math.abs(x2 - x1) * 0.4);
        return (
          <svg style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 9998 }}>
            <defs>
              <linearGradient id="issueConnGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.6" />
                <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.3" />
              </linearGradient>
            </defs>
            <path d={`M ${x1} ${y1} C ${x1 + cpOffset} ${y1}, ${x2 - cpOffset} ${y2}, ${x2} ${y2}`} fill="none" stroke="rgba(245, 158, 11, 0.15)" strokeWidth="6" strokeLinecap="round" />
            <path d={`M ${x1} ${y1} C ${x1 + cpOffset} ${y1}, ${x2 - cpOffset} ${y2}, ${x2} ${y2}`} fill="none" stroke="url(#issueConnGrad)" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx={x1} cy={y1} r="3" fill="#f59e0b" opacity="0.5" />
            <circle cx={x2} cy={y2} r="3" fill="#f59e0b" opacity="0.5" />
          </svg>
        );
      })()}

      {issuesPanelOpen && selectedAgent && (
        <div
          ref={issuesPanelRef}
          style={{
            position: 'fixed',
            left: issuesPanelPos.x,
            top: issuesPanelPos.y,
            width: 360,
            maxHeight: 440,
            zIndex: 9999,
            background: 'rgba(255, 255, 255, 0.18)',
            backdropFilter: 'blur(80px) saturate(2.2)',
            WebkitBackdropFilter: 'blur(80px) saturate(2.2)',
            border: '1px solid rgba(245, 158, 11, 0.2)',
            borderRadius: 16,
            boxShadow: '0 24px 80px rgba(0, 0, 0, 0.08), 0 8px 32px rgba(0, 0, 0, 0.04), inset 0 0.5px 0 rgba(255, 255, 255, 0.4)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            animation: 'drillFadeIn 180ms cubic-bezier(0.32, 0.72, 0, 1)',
          }}
        >
          <div
            onMouseDown={handleIssuesDragStart}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 14px 10px', cursor: 'grab', userSelect: 'none',
              borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.02em' }}>
                  Assign to {selectedAgent}
                </span>
                <span style={{ fontSize: 9, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                  {resolveAgentRepo(selectedAgent).split('/')[1] ?? 'cortex-ide'}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setIssuesPanelOpen(false)}
              aria-label="Close"
              style={{
                width: 22, height: 22, borderRadius: 11,
                border: 'none', background: 'rgba(255,255,255,0.12)',
                color: 'var(--t-text-muted)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 13, fontWeight: 600, lineHeight: 1,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.2)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
            >
              ×
            </button>
          </div>

          <div style={{
            padding: '8px 14px 14px', overflowY: 'auto', flex: 1,
            display: 'flex', flexDirection: 'column', gap: 6,
          }}>
            {issuesLoading && (
              <div style={{ textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 11, padding: 16 }}>
                Loading issues…
              </div>
            )}

            {!issuesLoading && ghIssues.map((issue) => (
              <div
                key={issue.number}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8,
                  background: 'rgba(255, 255, 255, 0.1)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: 10, padding: '8px 10px',
                  transition: 'all 120ms',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.18)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                    <span style={{ fontSize: 10, color: '#f59e0b', fontWeight: 700, fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                      #{issue.number}
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {issue.title}
                    </span>
                  </div>
                  {issue.labels.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {issue.labels.slice(0, 3).map((label, li) => {
                        const labelName = typeof label === 'string' ? label : label.name;
                        return (
                          <span key={li} style={{
                            fontSize: 9, padding: '1px 5px', borderRadius: 4,
                            background: 'rgba(255, 255, 255, 0.15)',
                            color: 'var(--t-text-muted)', fontWeight: 500,
                          }}>
                            {labelName}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleAssignIssue(issue.number)}
                  disabled={assigningIssue === issue.number}
                  style={{
                    height: 24, borderRadius: 6, border: 'none',
                    background: assigningIssue === issue.number ? 'rgba(245, 158, 11, 0.3)' : 'rgba(245, 158, 11, 0.15)',
                    color: '#f59e0b', cursor: assigningIssue === issue.number ? 'wait' : 'pointer',
                    fontSize: 10, fontWeight: 700, padding: '0 8px',
                    flexShrink: 0, transition: 'all 120ms',
                  }}
                  onMouseEnter={(e) => { if (assigningIssue !== issue.number) e.currentTarget.style.background = 'rgba(245, 158, 11, 0.25)'; }}
                  onMouseLeave={(e) => { if (assigningIssue !== issue.number) e.currentTarget.style.background = 'rgba(245, 158, 11, 0.15)'; }}
                >
                  {assigningIssue === issue.number ? '…' : 'Assign'}
                </button>
              </div>
            ))}

            {!issuesLoading && ghIssues.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 11, padding: 16 }}>
                No open issues
              </div>
            )}
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}
