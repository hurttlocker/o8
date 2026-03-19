'use client';

import { memo, useMemo } from 'react';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import type { AgentSummary } from '@/lib/fleet/types';

interface FleetViewProps {
  snapshot: MobileInboxSnapshot;
  onAgentSelect: (sessionKey: string) => void;
  onBack: () => void;
  onLaunch: () => void;
}

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function shortModel(model: string): string {
  return model
    .replace('anthropic/', '')
    .replace('openai-codex/', '')
    .replace('openai/', '')
    .replace('claude-', '')
    .split('-').slice(0, 2).join('-');
}

// Context ring — thin arc showing context usage
function ContextRing({ percent, size = 28 }: { percent: number; size?: number }) {
  const r = (size - 4) / 2;
  const circ = 2 * Math.PI * r;
  const filled = (percent / 100) * circ;
  const color = percent > 70 ? '#ff3b30' : percent > 40 ? '#ff9f0a' : '#007aff';

  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none"
        stroke="rgba(0,122,255,0.08)" strokeWidth={2.5} />
      <circle cx={size/2} cy={size/2} r={r} fill="none"
        stroke={color} strokeWidth={2.5}
        strokeDasharray={`${filled} ${circ - filled}`}
        strokeLinecap="round"
        style={{ transition: 'stroke-dasharray 600ms ease' }} />
      <text x={size/2} y={size/2} textAnchor="middle" dominantBaseline="central"
        style={{
          transform: 'rotate(90deg)',
          transformOrigin: `${size/2}px ${size/2}px`,
          fontSize: 8, fontWeight: 700,
          fill: color, fontFamily: '-apple-system, system-ui, sans-serif',
        }}>
        {percent}
      </text>
    </svg>
  );
}

function AgentCard({ agent, onSelect }: { agent: AgentSummary; onSelect: () => void }) {
  const isRunning = agent.status === 'running';
  const isDone = agent.status === 'idle' && agent.currentTask;
  const contextPct = agent.context?.usedPercent ?? 0;

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        padding: '14px 16px',
        borderRadius: 16,
        border: '1px solid rgba(0,122,255,0.08)',
        background: 'rgba(0,122,255,0.03)',
        backdropFilter: 'blur(20px) saturate(1.6)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        textAlign: 'left',
        transition: 'all 200ms ease',
      }}
    >
      {/* Status dot + context ring */}
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <ContextRing percent={contextPct} size={36} />
        <span style={{
          position: 'absolute',
          bottom: -1, right: -1,
          width: 10, height: 10,
          borderRadius: '50%',
          background: isRunning ? '#34c759' : isDone ? '#007aff' : '#8e8e93',
          border: '2px solid #fff',
          boxShadow: isRunning ? '0 0 6px rgba(52,199,89,0.5)' : 'none',
          animation: isRunning ? 'fleetPulse 2s ease-in-out infinite' : 'none',
        }} />
      </div>

      {/* Agent info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Name + model */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{
            fontSize: 15, fontWeight: 700,
            fontFamily: '-apple-system, system-ui, sans-serif',
            color: '#0a0a0a',
            letterSpacing: '-0.02em',
          }}>
            {agent.name}
          </span>
          <span style={{
            fontSize: 10, fontWeight: 600,
            color: 'rgba(0,122,255,0.5)',
            fontFamily: '"SF Mono", ui-monospace, monospace',
            letterSpacing: '-0.01em',
          }}>
            {shortModel(agent.model)}
          </span>
        </div>

        {/* Current task */}
        <p style={{
          margin: '3px 0 0',
          fontSize: 12, lineHeight: 1.4,
          color: '#64748b',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {agent.currentTask || 'No active task'}
        </p>

        {/* Meta row */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          marginTop: 6,
        }}>
          {/* Branch */}
          {agent.branch && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              padding: '2px 7px',
              borderRadius: 6,
              background: 'rgba(0,122,255,0.06)',
              border: '1px solid rgba(0,122,255,0.08)',
              fontSize: 10, fontWeight: 600,
              color: 'rgba(0,80,200,0.6)',
              fontFamily: '"SF Mono", ui-monospace, monospace',
            }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
              {agent.branch.length > 20 ? agent.branch.slice(0, 20) + '…' : agent.branch}
            </span>
          )}

          {/* Workspace */}
          {agent.workspace && (
            <span style={{
              fontSize: 10, color: '#94a3b8',
              fontWeight: 500,
            }}>
              {agent.workspace}
            </span>
          )}

          {/* Last active */}
          <span style={{
            fontSize: 10, color: '#cbd5e1',
            marginLeft: 'auto',
          }}>
            {formatRelativeTime(agent.lastEventAt)}
          </span>
        </div>
      </div>

      {/* Chevron */}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="#c7c7cc" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
        style={{ flexShrink: 0 }}>
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </button>
  );
}

export const FleetView = memo(function FleetView({
  snapshot,
  onAgentSelect,
  onBack,
  onLaunch,
}: FleetViewProps) {
  const { running, idle, done } = useMemo(() => {
    const r: AgentSummary[] = [];
    const i: AgentSummary[] = [];
    const d: AgentSummary[] = [];
    for (const s of snapshot.sessions) {
      if (s.status === 'running') r.push(s);
      else if (s.currentTask) d.push(s);
      else i.push(s);
    }
    return { running: r, idle: i, done: d };
  }, [snapshot.sessions]);

  const totalAgents = snapshot.sessions.length;
  const totalRunning = running.length;

  return (
    <div style={{
      padding: '0 14px 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingTop: 8,
      }}>
        <div>
          <h2 style={{
            margin: 0,
            fontSize: 28,
            fontWeight: 800,
            fontFamily: '-apple-system, system-ui, sans-serif',
            color: '#0a0a0a',
            letterSpacing: '-0.03em',
          }}>
            Fleet
          </h2>
          <p style={{
            margin: '2px 0 0',
            fontSize: 13,
            color: '#8e8e93',
            fontWeight: 500,
          }}>
            {totalAgents} agent{totalAgents !== 1 ? 's' : ''} · {totalRunning} running
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={onLaunch}
            style={{
              padding: '6px 14px',
              borderRadius: 10,
              background: '#007aff',
              border: 'none',
              color: '#fff',
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Launch
          </button>
          <button
            type="button"
            onClick={onBack}
            style={{
              padding: '6px 14px',
              borderRadius: 10,
              background: 'rgba(0,122,255,0.08)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              border: '1px solid rgba(0,122,255,0.12)',
              color: '#007aff',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            Done
          </button>
        </div>
      </div>

      {/* Summary cards row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        gap: 8,
      }}>
        {[
          { label: 'Running', count: running.length, color: '#34c759', bg: 'rgba(52,199,89,0.06)', border: 'rgba(52,199,89,0.12)' },
          { label: 'Idle', count: idle.length, color: '#8e8e93', bg: 'rgba(142,142,147,0.06)', border: 'rgba(142,142,147,0.12)' },
          { label: 'Done', count: done.length, color: '#007aff', bg: 'rgba(0,122,255,0.06)', border: 'rgba(0,122,255,0.12)' },
        ].map((stat) => (
          <div key={stat.label} style={{
            padding: '12px 10px',
            borderRadius: 12,
            background: stat.bg,
            border: `1px solid ${stat.border}`,
            textAlign: 'center',
          }}>
            <div style={{
              fontSize: 22, fontWeight: 800,
              fontFamily: '-apple-system, system-ui, sans-serif',
              color: stat.color,
              letterSpacing: '-0.02em',
            }}>
              {stat.count}
            </div>
            <div style={{
              fontSize: 11, fontWeight: 600,
              color: '#8e8e93',
              marginTop: 2,
            }}>
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      {/* Running agents */}
      {running.length > 0 && (
        <section>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            marginBottom: 8,
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: '#34c759',
              boxShadow: '0 0 6px rgba(52,199,89,0.4)',
              animation: 'fleetPulse 2s ease-in-out infinite',
            }} />
            <span style={{
              fontSize: 12, fontWeight: 700,
              color: '#34c759',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}>
              Running
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {running.map((agent) => (
              <AgentCard key={agent.id} agent={agent} onSelect={() => onAgentSelect(agent.sessionKey)} />
            ))}
          </div>
        </section>
      )}

      {/* Idle agents */}
      {idle.length > 0 && (
        <section>
          <span style={{
            display: 'block',
            fontSize: 12, fontWeight: 700,
            color: '#8e8e93',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: 8,
          }}>
            Idle
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {idle.map((agent) => (
              <AgentCard key={agent.id} agent={agent} onSelect={() => onAgentSelect(agent.sessionKey)} />
            ))}
          </div>
        </section>
      )}

      {/* Done */}
      {done.length > 0 && (
        <section>
          <span style={{
            display: 'block',
            fontSize: 12, fontWeight: 700,
            color: '#007aff',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: 8,
          }}>
            Completed
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {done.map((agent) => (
              <AgentCard key={agent.id} agent={agent} onSelect={() => onAgentSelect(agent.sessionKey)} />
            ))}
          </div>
        </section>
      )}

      {/* Empty state */}
      {totalAgents === 0 && (
        <div style={{
          padding: '40px 20px',
          textAlign: 'center',
        }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none"
            stroke="rgba(0,122,255,0.2)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            style={{ margin: '0 auto 12px' }}>
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
          <p style={{
            fontSize: 15, fontWeight: 600, color: '#8e8e93',
            margin: 0,
          }}>
            No agents connected
          </p>
          <p style={{
            fontSize: 12, color: '#c7c7cc',
            margin: '4px 0 0',
          }}>
            Agents will appear here when they connect to your gateway.
          </p>
        </div>
      )}

      <style>{`
        @keyframes fleetPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
});
