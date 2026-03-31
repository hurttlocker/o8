'use client';

import { memo, useMemo, useState, useCallback } from 'react';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import type { AgentSummary } from '@/lib/fleet/types';
import { ContextUsageRing } from '@/components/ContextUsageRing';
import { useLongPress, ContextMenu, type ContextMenuItem } from './ContextMenu';
import { EmptyState } from './EmptyState';

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
function AgentCard({ agent, onSelect, onKill, onMessage }: { agent: AgentSummary; onSelect: () => void; onKill?: () => void; onMessage?: () => void }) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const longPress = useLongPress((x, y) => setCtxMenu({ x, y }));

  const ctxItems: ContextMenuItem[] = [
    { id: 'message', label: 'Message', iconPath: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' },
    ...(agent.status === 'running' ? [{
      id: 'kill', label: 'Stop Agent', iconPath: 'M18 6L6 18 M6 6l12 12', destructive: true,
    }] : []),
  ];

  const handleCtxSelect = useCallback((id: string) => {
    if (id === 'message') onMessage?.() ?? onSelect();
    if (id === 'kill') onKill?.();
    setCtxMenu(null);
  }, [onSelect, onKill, onMessage]);
  const isRunning = agent.status === 'running';
  const isDone = agent.status === 'idle' && agent.currentTask;
  const contextPct = agent.context?.usedPercent ?? 0;

  return (
    <>
    <button
      type="button"
      onClick={onSelect}
      {...longPress}
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
        <ContextUsageRing percent={contextPct} size={36} />
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
    {ctxMenu ? (
      <ContextMenu
        visible={true}
        x={ctxMenu.x} y={ctxMenu.y}
        items={ctxItems}
        onSelect={handleCtxSelect}
        onClose={() => setCtxMenu(null)}
      />
    ) : null}
    </>
  );
}

function CollapsibleSection({ label, count, color, defaultOpen = true, children }: {
  label: string; count: number; color: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        onTouchEnd={(e) => { setOpen(!open); e.preventDefault(); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          marginBottom: open ? 8 : 0,
          padding: '6px 0',
          border: 'none', background: 'transparent',
          cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
          width: '100%', touchAction: 'manipulation',
        }}
      >
        {label === 'Running' ? (
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: color,
            boxShadow: `0 0 6px ${color}60`,
            animation: 'fleetPulse 2s ease-in-out infinite',
          }} />
        ) : null}
        <span style={{
          fontSize: 12, fontWeight: 700, color,
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          {label}
        </span>
        <span style={{
          fontSize: 10, fontWeight: 700, color: '#8e8e93',
          minWidth: 16, height: 16, borderRadius: 8, padding: '0 4px',
          background: 'rgba(0,0,0,0.04)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {count}
        </span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="#8e8e93" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{
            marginLeft: 'auto',
            transition: 'transform 200ms ease',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <div style={{
        maxHeight: open ? 2000 : 0,
        opacity: open ? 1 : 0,
        overflow: 'hidden',
        transition: 'all 300ms cubic-bezier(0.32, 0.72, 0, 1)',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        {children}
      </div>
    </section>
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
      gap: 14,
      width: '100%',
      maxWidth: '100%',
      boxSizing: 'border-box',
      overflow: 'hidden',
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
            Agents
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

      {/* Running agents — expanded by default */}
      {running.length > 0 && (
        <CollapsibleSection label="Running" count={running.length} color="#34c759" defaultOpen>
          {running.map((agent) => (
            <AgentCard key={agent.id} agent={agent} onSelect={() => onAgentSelect(agent.sessionKey)} />
          ))}
        </CollapsibleSection>
      )}

      {/* Idle agents — collapsed by default */}
      {idle.length > 0 && (
        <CollapsibleSection label="Idle" count={idle.length} color="#8e8e93" defaultOpen={false}>
          {idle.map((agent) => (
            <AgentCard key={agent.id} agent={agent} onSelect={() => onAgentSelect(agent.sessionKey)} />
          ))}
        </CollapsibleSection>
      )}

      {/* Done */}
      {/* Done — collapsed by default */}
      {done.length > 0 && (
        <CollapsibleSection label="Completed" count={done.length} color="#007aff" defaultOpen={false}>
          {done.map((agent) => (
            <AgentCard key={agent.id} agent={agent} onSelect={() => onAgentSelect(agent.sessionKey)} />
          ))}
        </CollapsibleSection>
      )}

      {/* Empty state with personality */}
      {totalAgents === 0 && (
        <EmptyState
          iconPath="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75"
          title="No agents running"
          subtitle="Launch one to get started."
          actionLabel="Launch Agent"
          onAction={onLaunch}
        />
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
