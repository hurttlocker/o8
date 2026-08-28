'use client';
/* eslint-disable react-hooks/exhaustive-deps -- preserved from legacy Canvas.tsx extraction */
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type { AgentSummary } from '@/lib/fleet/types';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import { formatAge } from '@/components/desktop/canvas-utils';
import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
type ReplaySegment = { kind: string; startMin: number; durationMin: number; label?: string; agent?: string };
const THEME_ACCENT = 'var(--t-accent, #2563eb)';
const REPLAY_CARD_BACKGROUND = 'linear-gradient(180deg, var(--t-panel-translucent) 0%, var(--t-bg-card, rgba(148, 163, 184, 0.08)) 100%)';
function sessionReplayRuntimePalette(runtime?: string) {
  switch (runtime) {
    case 'Codex':
      return { color: '#4ade80', background: 'rgba(34, 197, 94, 0.12)', border: 'rgba(34, 197, 94, 0.18)' };
    default:
      return { color: 'var(--t-text-secondary)', background: 'var(--t-divider-subtle)', border: 'var(--t-panel-border)' };
  }
}
function timelineReplayDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
function timelineReplayTime(minutesSinceAnchor: number): string {
  const h = 6 + Math.floor(minutesSinceAnchor / 60);
  const m = minutesSinceAnchor % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}
function timelineReplayRuntimeLabel(runtime: string | null | undefined): string {
  if (!runtime) return 'Runtime';
  // Capability-map lookup; optional chaining guards against unknown string values.
  return ORCHESTRATOR_RUNTIMES[runtime as keyof typeof ORCHESTRATOR_RUNTIMES]?.label ?? runtime;
}
function timelineReplayWorkspace(path: string | null | undefined): string | null {
  if (!path || path === 'unknown') return null;
  const normalized = path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length <= 4 ? normalized : `~/${parts.slice(-4).join('/')}`;
}
function timelineReplayTask(task: string | null | undefined): string | null {
  if (!task) return null;
  return task
    .replace(/^IDE-owned Codex session ready for the next input via resume\.?\s*/i, '')
    .replace(/^Live Codex terminal verified via pid\/log mapping on s\d+\.\s*/i, '')
    .replace(/^Live Codex terminal detected on s\d+\.\s*/i, '')
    .replace(/^Recent automation surface; useful for visibility, not the primary operator lane\.?\s*/i, '')
    .replace(/^Mirroring the live Q ↔ Mister conversation, not spawning a fresh session\.?\s*/i, '')
    .trim();
}
function timelineReplayMatchesAgent(agentName: string, session: AgentSummary): boolean {
  const key = session.sessionKey.toLowerCase();
  const name = (session.name || '').toLowerCase();
  if (agentName === 'codex') return session.runtime === 'codex';
  const loweredAgent = agentName.toLowerCase();
  return name.includes(loweredAgent) || key.includes(loweredAgent);
}
function timelineReplayPrimarySession(sessions: AgentSummary[]): AgentSummary | null {
  if (sessions.length === 0) return null;
  const statusWeight = (status: string) => {
    switch (status) {
      case 'running': return 4;
      case 'reviewing': return 3;
      case 'waiting': return 2;
      case 'idle': return 1;
      default: return 0;
    }
  };
  return [...sessions].sort((a, b) => {
    if (Boolean(a.isCurrentSession) !== Boolean(b.isCurrentSession)) return a.isCurrentSession ? -1 : 1;
    const delta = statusWeight(b.status) - statusWeight(a.status);
    if (delta !== 0) return delta;
    return new Date(b.lastEventAt || 0).getTime() - new Date(a.lastEventAt || 0).getTime();
  })[0] ?? null;
}

function StatBlock({ value, label, isCompact, tone = 'default' }: { value: string; label: string; isCompact: boolean; tone?: 'default' | 'active' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 56 }}>
      <div style={{
        fontSize: isCompact ? 18 : 22,
        fontWeight: 300,
        letterSpacing: '-0.02em',
        color: tone === 'active' ? 'var(--t-accent, #2563eb)' : 'var(--t-text)',
        lineHeight: 1,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </div>
      <div style={{
        fontSize: 9,
        fontWeight: 300,
        letterSpacing: '0.1em',
        color: 'var(--t-text-muted)',
        textTransform: 'uppercase',
      }}>
        {label}
      </div>
    </div>
  );
}

export function TimelineExpanded() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [segments, setSegments] = useState<ReplaySegment[]>([]);
  const [sessions, setSessions] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const fetchReplay = async () => {
      try {
        if (segments.length === 0) setLoading(true);
        setError(null);
        const [timelineRes, inboxRes] = await Promise.all([
          fetch('/api/panel/timeline', { cache: 'no-store' }).catch(() => null),
          fetch('/api/mobile/inbox', { cache: 'no-store' }).catch(() => null),
        ]);

        if (timelineRes?.ok) {
          const timelineData = await timelineRes.json() as { segments?: ReplaySegment[] };
          if (active) {
            setSegments(timelineData.segments ?? []);
            setGeneratedAt(new Date().toISOString());
          }
        } else if (active) {
          setSegments([]);
        }

        if (inboxRes?.ok) {
          const inboxData = await inboxRes.json() as MobileInboxSnapshot;
          if (active) setSessions(inboxData.sessions ?? []);
        } else if (active) {
          setSessions([]);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Unable to load session replay.');
          setSegments([]);
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    void fetchReplay();
    // WS-driven: refresh on agent events instead of 30s polling
    const handler = () => { void fetchReplay(); };
    const wsEvents = ['o8:lifecycle-reconcile'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = setInterval(fetchReplay, 300_000);
    return () => {
      active = false;
      clearInterval(fallbackId);
      for (const e of wsEvents) window.removeEventListener(e, handler);
    };
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width ?? 0;
      setContainerWidth(nextWidth);
    });
    observer.observe(node);
    setContainerWidth(node.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  const colors: Record<string, string> = { coding: THEME_ACCENT, thinking: '#9aa8bd', testing: '#d9a441', error: '#ef4444', idle: 'rgba(255, 255, 255, 0.14)' };
  const labels: Record<string, string> = { coding: 'CODING', thinking: 'THINKING', testing: 'TESTING', error: 'ERRORS', idle: 'IDLE' };
  const totalMin = segments.length > 0 ? segments[segments.length - 1].startMin + segments[segments.length - 1].durationMin : 0;
  const totals = useMemo(() => {
    const map: Record<string, number> = {};
    for (const segment of segments) map[segment.kind] = (map[segment.kind] || 0) + segment.durationMin;
    return map;
  }, [segments]);

  const agentBreakdown = useMemo(() => {
    const map = new Map<string, {
      agent: string;
      segments: ReplaySegment[];
      totalMin: number;
      breakdown: Record<string, number>;
    }>();
    for (const segment of segments) {
      const agent = segment.agent || 'Unscoped';
      if (!map.has(agent)) map.set(agent, { agent, segments: [], totalMin: 0, breakdown: {} });
      const entry = map.get(agent)!;
      entry.segments.push(segment);
      entry.totalMin += segment.durationMin;
      entry.breakdown[segment.kind] = (entry.breakdown[segment.kind] || 0) + segment.durationMin;
    }
    return Array.from(map.values()).sort((a, b) => b.totalMin - a.totalMin);
  }, [segments]);

  const liveSessionContext = useMemo(() => {
    const contexts = new Map<string, {
      runtime: string;
      label: string;
      location: string | null;
      summary: string;
      extra: string | null;
    }>();

    for (const agent of agentBreakdown) {
      const matches = sessions.filter((session) => timelineReplayMatchesAgent(agent.agent, session));
      const primary = timelineReplayPrimarySession(matches);
      if (!primary) continue;

      const repoSlug = primary.runtimeSurface?.reviewContext?.repoSlug || '';
      const repoName = repoSlug.split('/')[1] || null;
      const location = repoName
        ? `${repoName}${primary.branch ? ` · ${primary.branch}` : ''}`
        : timelineReplayWorkspace(primary.workspace) ?? primary.surfaceLabel ?? primary.branch ?? null;

      contexts.set(agent.agent, {
        runtime: timelineReplayRuntimeLabel(primary.runtime),
        label: primary.surfaceLabel || primary.name || timelineReplayRuntimeLabel(primary.runtime),
        location,
        summary: timelineReplayTask(primary.currentTask) || primary.surfaceLabel || primary.name || 'No current task detail',
        extra: matches.length > 1 ? `+${matches.length - 1} more live` : null,
      });
    }

    return contexts;
  }, [agentBreakdown, sessions]);

  const liveSessions = useMemo(() => {
    return [...sessions]
      .filter((session) => ['running', 'reviewing', 'waiting'].includes(session.status) || session.isCurrentSession)
      .sort((a, b) => {
        if (Boolean(a.isCurrentSession) !== Boolean(b.isCurrentSession)) return a.isCurrentSession ? -1 : 1;
        return new Date(b.lastEventAt || 0).getTime() - new Date(a.lastEventAt || 0).getTime();
      })
      .slice(0, 8);
  }, [sessions]);

  const recentSlices = useMemo(
    () => [...segments].slice(-(containerWidth > 0 && containerWidth < 760 ? 6 : 10)).reverse(),
    [containerWidth, segments],
  );

  const isTight = containerWidth > 0 && containerWidth < 1040;
  const isCompact = containerWidth > 0 && containerWidth < 760;
  const outerPadding = isCompact ? 14 : isTight ? 18 : 24;
  const sectionPadding = isCompact ? 14 : isTight ? 16 : 20;
  const sectionRadius = isCompact ? 16 : 18;
  const titleSize = isCompact ? 18 : 20;
  const summaryBarHeight = isCompact ? 32 : 40;
  const contentColumns = isTight ? '1fr' : '1.15fr 0.85fr';

  return (
    <div
      className="cortex-themed-scroll"
      style={{
        height: '100%',
        overflow: 'auto',
        paddingTop: outerPadding,
        paddingRight: outerPadding,
        paddingBottom: outerPadding,
        paddingLeft: outerPadding,
        background: 'var(--t-bg-gradient)',
      }}
      ref={containerRef}
    >
      <div style={{ marginBottom: isCompact ? 14 : 20, display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: titleSize, fontWeight: 300, letterSpacing: '-0.03em', color: 'var(--t-text)', marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0 }}>
          Session Replay
        </h2>
        <span style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t-text-muted)', fontWeight: 300 }}>
          What, where, which surface
        </span>
      </div>

      {loading ? (
        <div
          style={{
            background: 'var(--t-panel)',
            borderRadius: sectionRadius,
            paddingTop: sectionPadding,
            paddingRight: sectionPadding,
            paddingBottom: sectionPadding,
            paddingLeft: sectionPadding,
            border: '1px solid var(--t-divider)',
            color: 'var(--t-text-muted)',
            fontSize: 13,
          }}
        >
          Loading session replay…
        </div>
      ) : error ? (
        <div
          style={{
            background: 'rgba(239,68,68,0.08)',
            borderRadius: sectionRadius,
            paddingTop: sectionPadding,
            paddingRight: sectionPadding,
            paddingBottom: sectionPadding,
            paddingLeft: sectionPadding,
            border: '1px solid rgba(239,68,68,0.18)',
            color: '#b91c1c',
            fontSize: 13,
          }}
        >
          {error}
        </div>
      ) : segments.length === 0 ? (
        <div
          style={{
            background: 'var(--t-panel)',
            borderRadius: sectionRadius,
            paddingTop: sectionPadding,
            paddingRight: sectionPadding,
            paddingBottom: sectionPadding,
            paddingLeft: sectionPadding,
            border: '1px solid var(--t-divider)',
            color: 'var(--t-text-muted)',
            fontSize: 13,
          }}
        >
          No replay data is available yet. This surface only shows real session activity.
        </div>
      ) : (
        <>
          <div
            style={{
              background: 'var(--t-panel)',
              borderRadius: sectionRadius,
              paddingTop: isCompact ? 16 : isTight ? 18 : 22,
              paddingRight: isCompact ? 16 : isTight ? 18 : 22,
              paddingBottom: isCompact ? 16 : isTight ? 18 : 22,
              paddingLeft: isCompact ? 16 : isTight ? 18 : 22,
              marginBottom: isCompact ? 14 : 18,
              border: '1px solid var(--t-divider)',
              boxShadow: 'var(--t-panel-shadow)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'space-between',
                gap: 12,
                marginBottom: isCompact ? 12 : 16,
                flexWrap: 'wrap',
              }}
            >
              <div>
                <div style={{ fontSize: 12, fontWeight: 320, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t-text-secondary)' }}>
                  Today
                </div>
                <div style={{ marginTop: 4, fontSize: isCompact ? 16 : 18, fontWeight: 200, letterSpacing: '-0.03em', color: 'var(--t-text)' }}>
                  {timelineReplayTime(0)} → {timelineReplayTime(totalMin)}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <StatBlock value={timelineReplayDuration(totalMin)} label="TOTAL" isCompact={isCompact} />
                <StatBlock value={String(agentBreakdown.length)} label={agentBreakdown.length === 1 ? 'ACTIVE LANE' : 'ACTIVE LANES'} isCompact={isCompact} />
                <StatBlock value={String(liveSessions.length)} label={liveSessions.length === 1 ? 'LIVE SURFACE' : 'LIVE SURFACES'} isCompact={isCompact} tone={liveSessions.length > 0 ? 'active' : 'default'} />
              </div>
            </div>

            <div
              style={{
                height: summaryBarHeight,
                borderRadius: isCompact ? 8 : 10,
                overflow: 'hidden',
                display: 'flex',
                background: 'var(--t-divider-subtle)',
                border: '1px solid var(--t-panel-border)',
              }}
            >
              {segments.map((seg, i) => (
                <div
                  key={`${seg.agent ?? 'unscoped'}:${seg.kind}:${seg.startMin}:${i}`}
                  style={{
                    width: `${(seg.durationMin / totalMin) * 100}%`,
                    height: '100%',
                    background: colors[seg.kind] || '#e5e7eb',
                    borderRight: i < segments.length - 1 ? '1px solid rgba(255,255,255,0.08)' : 'none',
                  }}
                  title={`${labels[seg.kind] || seg.kind} · ${seg.agent ?? 'Unknown'} · ${timelineReplayDuration(seg.durationMin)} · ${timelineReplayTime(seg.startMin)}`}
                />
              ))}
            </div>

            <div style={{ display: 'flex', gap: isCompact ? 12 : 18, marginTop: isCompact ? 10 : 14, flexWrap: 'wrap' }}>
              {(['thinking', 'coding', 'testing', 'error'] as const).map((kind) => {
                const total = totals[kind];
                if (!total) return null;
                return (
                  <div key={kind} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 999, background: colors[kind] }} />
                    <span style={{ fontSize: isCompact ? 10 : 11, fontWeight: 320, color: 'var(--t-text)' }}>{labels[kind]}</span>
                    <span style={{ fontSize: isCompact ? 10 : 11, color: 'var(--t-text-muted)' }}>{timelineReplayDuration(total)}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: contentColumns,
              gap: isCompact ? 14 : 18,
              marginBottom: isCompact ? 14 : 18,
            }}
          >
            <div
              style={{
                background: 'var(--t-panel)',
                borderRadius: sectionRadius,
                paddingTop: sectionPadding,
                paddingRight: sectionPadding,
                paddingBottom: sectionPadding,
                paddingLeft: sectionPadding,
                border: '1px solid var(--t-divider)',
                boxShadow: 'var(--t-panel-shadow)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: isCompact ? 'flex-start' : 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  flexWrap: 'wrap',
                  marginBottom: isCompact ? 12 : 16,
                }}
              >
                <h3 style={{ fontSize: isCompact ? 11 : 12, fontWeight: 320, color: 'var(--t-text)', letterSpacing: '0.05em', textTransform: 'uppercase', marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0 }}>
                  Replay Lanes
                </h3>
                <span style={{ fontSize: 10, color: 'var(--t-text-muted)', fontWeight: 300 }}>
                  Generated {generatedAt ? formatAge(generatedAt) : 'just now'}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: isCompact ? 10 : 14 }}>
                {agentBreakdown.map((entry, laneIndex) => {
                  const context = liveSessionContext.get(entry.agent);
                  const runtimePalette = sessionReplayRuntimePalette(context?.runtime);
                  return (
                    <motion.div
                      key={entry.agent}
                      // Entrance: stagger fade + slide-up so the lanes
                      // cascade in when the Session Replay page loads.
                      // Hover: brighten the border + a quiet ambient
                      // glow — no translate (flat-doctrine), the card
                      // sits still and the chrome warms instead.
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{
                        delay: 0.04 + laneIndex * 0.06,
                        type: 'spring',
                        stiffness: 280,
                        damping: 28,
                        mass: 0.7,
                      }}
                      whileHover={{
                        borderColor: 'var(--t-divider, var(--t-text-muted))',
                        boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 4px 18px rgba(15, 23, 42, 0.08)',
                      }}
                      style={{
                        borderRadius: isCompact ? 14 : 16,
                        border: '1px solid var(--t-panel-border)',
                        paddingTop: isCompact ? 12 : 16,
                        paddingRight: isCompact ? 12 : 16,
                        paddingBottom: isCompact ? 12 : 16,
                        paddingLeft: isCompact ? 12 : 16,
                        background: REPLAY_CARD_BACKGROUND,
                        boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.03)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: isCompact ? 14 : 15, fontWeight: 200, color: 'var(--t-text)', letterSpacing: '-0.02em' }}>
                            {entry.agent}
                          </div>
                          <div style={{ fontSize: isCompact ? 10 : 11, color: 'var(--t-text-muted)', marginTop: 3 }}>
                            {context?.label ?? 'Historical lane without a live matched surface'}
                          </div>
                        </div>
                        <div
                          style={{
                            fontSize: isCompact ? 11 : 12,
                            fontWeight: 320,
                            color: 'var(--t-text-secondary)',
                            fontFamily: '"SF Mono", ui-monospace, monospace',
                          }}
                        >
                          {timelineReplayDuration(entry.totalMin)}
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                        {context ? (
                          <>
                            <span
                              style={{
                                fontSize: isCompact ? 9 : 10,
                                fontWeight: 320,
                                color: runtimePalette.color,
                                background: runtimePalette.background,
                                border: `1px solid ${runtimePalette.border}`,
                                borderRadius: 999,
                                paddingTop: isCompact ? 2 : 3,
                                paddingRight: 7,
                                paddingBottom: isCompact ? 2 : 3,
                                paddingLeft: 8,
                              }}
                            >
                              {context.runtime}
                            </span>
                            {context.location ? (
                              <span
                                style={{
                                  fontSize: isCompact ? 9 : 10,
                                  fontWeight: 300,
                                  color: 'var(--t-text-secondary)',
                                  background: 'var(--t-divider-subtle)',
                                  border: '1px solid var(--t-panel-border)',
                                  borderRadius: 999,
                                  paddingTop: isCompact ? 2 : 3,
                                  paddingRight: 7,
                                  paddingBottom: isCompact ? 2 : 3,
                                  paddingLeft: 8,
                                  fontFamily: '"SF Mono", ui-monospace, monospace',
                                }}
                              >
                                {context.location}
                              </span>
                            ) : null}
                            {context.extra ? (
                              <span
                                style={{
                                  fontSize: isCompact ? 9 : 10,
                                  fontWeight: 300,
                                  color: 'var(--t-text-muted)',
                                  background: 'var(--t-divider-subtle)',
                                  border: '1px solid var(--t-panel-border)',
                                  borderRadius: 999,
                                  paddingTop: isCompact ? 2 : 3,
                                  paddingRight: 7,
                                  paddingBottom: isCompact ? 2 : 3,
                                  paddingLeft: 8,
                                }}
                              >
                                {context.extra}
                              </span>
                            ) : null}
                          </>
                        ) : null}
                      </div>

                      <div style={{ marginTop: 8, fontSize: isCompact ? 11 : 12, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>
                        {context?.summary ?? 'No live session detail matched for this lane yet. The replay bar is still showing real recorded activity.'}
                      </div>

                      <div
                        style={{
                          height: isCompact ? 10 : 12,
                          borderRadius: 999,
                          overflow: 'hidden',
                          display: 'flex',
                          background: 'var(--t-divider-subtle)',
                          border: '1px solid var(--t-panel-border)',
                          marginTop: 10,
                        }}
                      >
                        {entry.segments.map((seg, i) => (
                          <div
                            key={`${entry.agent}:${seg.kind}:${seg.startMin}:${i}`}
                            style={{
                              width: `${(seg.durationMin / entry.totalMin) * 100}%`,
                              height: '100%',
                              background: colors[seg.kind] || '#e5e7eb',
                            }}
                            title={`${labels[seg.kind] || seg.kind} · ${timelineReplayDuration(seg.durationMin)} · ${timelineReplayTime(seg.startMin)}`}
                          />
                        ))}
                      </div>

                      <div style={{ display: 'flex', gap: isCompact ? 8 : 12, flexWrap: 'wrap', marginTop: 8 }}>
                        {(['coding', 'thinking', 'testing', 'error'] as const).map((kind) => {
                          const minutes = entry.breakdown[kind];
                          if (!minutes) return null;
                          return (
                            <div key={kind} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              <div style={{ width: 6, height: 6, borderRadius: 999, background: colors[kind] }} />
                              <span style={{ fontSize: isCompact ? 9 : 10, color: 'var(--t-text-muted)', fontWeight: 300 }}>
                                {labels[kind]} {timelineReplayDuration(minutes)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div
                style={{
                  background: 'var(--t-panel)',
                  borderRadius: sectionRadius,
                  paddingTop: sectionPadding,
                  paddingRight: sectionPadding,
                  paddingBottom: sectionPadding,
                  paddingLeft: sectionPadding,
                  border: '1px solid var(--t-divider)',
                  boxShadow: 'var(--t-panel-shadow)',
                }}
              >
                <h3
                  style={{
                    fontSize: isCompact ? 11 : 12,
                    fontWeight: 320,
                    color: 'var(--t-text)',
                    letterSpacing: '0.05em',
                    textTransform: 'uppercase',
                    marginTop: 0,
                    marginRight: 0,
                    marginBottom: isCompact ? 12 : 16,
                    marginLeft: 0,
                  }}
                >
                  Live Surfaces
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: isCompact ? 10 : 12 }}>
                  {liveSessions.map((session) => {
                    const runtime = timelineReplayRuntimeLabel(session.runtime);
                    const repoSlug = session.runtimeSurface?.reviewContext?.repoSlug || '';
                    const repoName = repoSlug.split('/')[1] || null;
                    const location = repoName
                      ? `${repoName}${session.branch ? ` · ${session.branch}` : ''}`
                      : timelineReplayWorkspace(session.workspace) ?? session.surfaceLabel ?? session.branch ?? 'unknown';
                    const runtimePalette = sessionReplayRuntimePalette(runtime);

                    return (
                      <div
                        key={session.sessionKey}
                        style={{
                          borderRadius: isCompact ? 12 : 14,
                          border: '1px solid var(--t-panel-border)',
                          paddingTop: isCompact ? 12 : 14,
                          paddingRight: isCompact ? 12 : 14,
                          paddingBottom: isCompact ? 12 : 14,
                          paddingLeft: isCompact ? 12 : 14,
                          background: REPLAY_CARD_BACKGROUND,
                          boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.03)',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <div style={{ minWidth: 0 }}>
                            <div
                              style={{
                                fontSize: isCompact ? 12 : 13,
                                fontWeight: 320,
                                color: 'var(--t-text)',
                                letterSpacing: '-0.01em',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {session.name}
                            </div>
                            <div style={{ fontSize: isCompact ? 10 : 10.5, color: 'var(--t-text-muted)', marginTop: 3 }}>
                              {location}
                            </div>
                          </div>
                          <span
                            style={{
                              fontSize: isCompact ? 9 : 10,
                              fontWeight: 320,
                              color: runtimePalette.color,
                              background: runtimePalette.background,
                              border: `1px solid ${runtimePalette.border}`,
                              borderRadius: 999,
                              paddingTop: isCompact ? 2 : 3,
                              paddingRight: 7,
                              paddingBottom: isCompact ? 2 : 3,
                              paddingLeft: 8,
                              flexShrink: 0,
                            }}
                          >
                            {runtime}
                          </span>
                        </div>
                        <div style={{ fontSize: isCompact ? 10.5 : 11.5, lineHeight: 1.5, color: 'var(--t-text-secondary)', marginTop: 8 }}>
                          {timelineReplayTask(session.currentTask) || 'No current task detail'}
                        </div>
                        <div style={{ fontSize: isCompact ? 9 : 10, color: 'var(--t-text-muted)', marginTop: 8 }}>
                          {session.surfaceLabel || session.status} · {formatAge(session.lastEventAt)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div
                style={{
                  background: 'var(--t-panel)',
                  borderRadius: sectionRadius,
                  paddingTop: sectionPadding,
                  paddingRight: sectionPadding,
                  paddingBottom: sectionPadding,
                  paddingLeft: sectionPadding,
                  border: '1px solid var(--t-divider)',
                  boxShadow: 'var(--t-panel-shadow)',
                }}
              >
                <h3
                  style={{
                    fontSize: isCompact ? 11 : 12,
                    fontWeight: 320,
                    color: 'var(--t-text)',
                    letterSpacing: '0.05em',
                    textTransform: 'uppercase',
                    marginTop: 0,
                    marginRight: 0,
                    marginBottom: isCompact ? 12 : 16,
                    marginLeft: 0,
                  }}
                >
                  Recent Slices
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: isCompact ? 8 : 10 }}>
                  {recentSlices.map((segment, index) => (
                    <div
                      key={`${segment.agent ?? 'unscoped'}:${segment.kind}:${segment.startMin}:${index}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        paddingBottom: isCompact ? 8 : 10,
                        borderBottom: index < recentSlices.length - 1 ? '1px solid var(--t-divider-subtle)' : 'none',
                      }}
                    >
                      <div style={{ width: 8, height: 8, borderRadius: 999, background: colors[segment.kind] || '#e5e7eb', flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: isCompact ? 11 : 12, fontWeight: 300, color: 'var(--t-text)' }}>
                          {(labels[segment.kind] || segment.kind)} · {segment.agent ?? 'Unscoped'}
                        </div>
                        <div style={{ fontSize: isCompact ? 9.5 : 10.5, color: 'var(--t-text-muted)', marginTop: 2 }}>
                          {timelineReplayTime(segment.startMin)} · {timelineReplayDuration(segment.durationMin)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
