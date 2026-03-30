'use client';

import { useState, useEffect, useCallback } from 'react';
import { formatModelLabel } from '@/lib/format';
import {
  readOrchestratorRuntimePreference,
  subscribeOrchestratorRuntimePreference,
  writeOrchestratorRuntimePreference,
} from '@/lib/orchestrator/preferences';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import {
  THEME_ACCENT,
  THEME_ACCENT_SOFT,
  THEME_ACCENT_BORDER,
  THEME_ACCENT_RING,
} from './shared';

interface FleetAgent {
  id: string;
  name: string;
  squadId: string;
  runtime: string;
  model: string;
  status: string;
  currentTask?: string;
  context?: { usedPercent: number; trend: string };
  sessionKey?: string;
  runtimeSurface?: {
    id?: string;
    ownership?: string;
    capabilities?: {
      interrupt?: boolean;
    };
  };
}

interface FleetSquad {
  id: string;
  name: string;
  status: string;
  throughputLabel: string;
  liveSessions: number;
  members: string[];
}

function StatusDot({ status }: { status: string }) {
  const color = status === 'running' ? '#22c55e'
    : status === 'reviewing' ? '#3b82f6'
      : status === 'idle' ? '#9ca3af'
        : status === 'failed' || status === 'blocked' ? '#ef4444'
          : '#f59e0b';
  return (
    <span style={{
      display: 'inline-block',
      width: 8,
      height: 8,
      borderRadius: 4,
      background: color,
      flexShrink: 0,
    }} />
  );
}

function ContextBar({ percent, trend }: { percent: number; trend: string }) {
  const barColor = percent > 70 ? '#ef4444' : percent > 50 ? '#f59e0b' : '#22c55e';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 120 }}>
      <div style={{
        flex: 1,
        height: 6,
        borderRadius: 3,
        background: 'var(--t-divider)',
        overflow: 'hidden',
      }}>
        <div style={{
          width: `${percent}%`,
          height: '100%',
          borderRadius: 3,
          background: barColor,
          transition: 'width 300ms ease',
        }} />
      </div>
      <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--t-text-secondary)', minWidth: 32, textAlign: 'right' }}>
        {percent}%
      </span>
      {trend === 'rising' ? <span style={{ fontSize: 9, color: '#f59e0b' }}>↑</span> : null}
    </div>
  );
}

function runtimeIcon(runtime: string) {
  if (runtime === 'claude-code') return '🤖';
  if (runtime === 'codex') return '⌨️';
  return '•';
}

function AgentCard({
  agent,
  interrupting,
  onInterrupt,
}: {
  agent: FleetAgent;
  interrupting: boolean;
  onInterrupt?: (agent: FleetAgent) => void;
}) {
  const canInterrupt = Boolean(agent.runtimeSurface?.capabilities?.interrupt);
  const shortModel = formatModelLabel(agent.model || (agent.runtime === 'claude-code' ? 'Claude Code' : 'Codex'));

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      padding: '14px 16px',
      borderRadius: 12,
      background: 'var(--t-panel)',
      border: '1px solid var(--t-panel-border)',
      boxShadow: 'var(--t-panel-shadow)',
    }}>
      <div style={{
        width: 40,
        height: 40,
        borderRadius: 10,
        display: 'grid',
        placeItems: 'center',
        background: 'var(--t-hover)',
        color: 'var(--t-text-secondary)',
        fontSize: 14,
        fontWeight: 700,
        flexShrink: 0,
      }}>
        {runtimeIcon(agent.runtime)}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <StatusDot status={agent.status} />
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)' }}>{agent.name}</span>
          <span style={{
            fontSize: 10,
            fontWeight: 600,
            padding: '1px 7px',
            borderRadius: 5,
            background: agent.status === 'running' ? 'rgba(34, 197, 94, 0.08)' : 'var(--t-divider-subtle)',
            color: agent.status === 'running' ? '#22c55e' : 'var(--t-text-muted)',
          }}>
            {agent.status}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--t-text-muted)' }}>
          <span style={{ fontWeight: 600, color: 'var(--t-text-secondary)' }}>{shortModel}</span>
          <span>·</span>
          <span>{agent.runtime === 'claude-code' ? 'Claude Code' : 'Codex'}</span>
          {agent.runtimeSurface?.ownership ? (
            <>
              <span>·</span>
              <span>{agent.runtimeSurface.ownership}</span>
            </>
          ) : null}
        </div>
        {agent.currentTask ? (
          <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 6, lineHeight: 1.45 }}>
            {agent.currentTask}
          </div>
        ) : null}
      </div>

      {agent.context ? (
        <div style={{ width: 140 }}>
          <ContextBar percent={agent.context.usedPercent} trend={agent.context.trend} />
        </div>
      ) : null}

      {canInterrupt && onInterrupt ? (
        <button
          type="button"
          onClick={() => onInterrupt(agent)}
          disabled={interrupting}
          style={{
            padding: '6px 12px',
            borderRadius: 8,
            border: interrupting ? '1px solid rgba(239, 68, 68, 0.4)' : '1px solid rgba(239, 68, 68, 0.2)',
            background: interrupting ? 'rgba(239, 68, 68, 0.08)' : 'var(--t-panel)',
            color: '#ef4444',
            fontSize: 11,
            fontWeight: 600,
            cursor: interrupting ? 'wait' : 'pointer',
            opacity: interrupting ? 0.7 : 1,
          }}
        >
          {interrupting ? 'Interrupting…' : 'Interrupt'}
        </button>
      ) : null}
    </div>
  );
}

export function AgentsTab() {
  const [squads, setSquads] = useState<FleetSquad[]>([]);
  const [agents, setAgents] = useState<FleetAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [interruptingId, setInterruptingId] = useState<string | null>(null);
  const [orchestratorRuntime, setOrchestratorRuntime] = useState<OrchestratorRuntime>(() => readOrchestratorRuntimePreference());

  const fetchFleet = useCallback(async () => {
    try {
      const res = await fetch('/api/runtime/inventory?fresh=1', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      setSquads(data.squads || []);
      setAgents((data.agents || []).filter((agent: FleetAgent) => agent.runtime === 'codex' || agent.runtime === 'claude-code'));
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchFleet(); }, [fetchFleet]);
  useEffect(() => subscribeOrchestratorRuntimePreference(setOrchestratorRuntime), []);

  useEffect(() => {
    const timer = setInterval(() => { void fetchFleet(); }, 30_000);
    return () => clearInterval(timer);
  }, [fetchFleet]);

  const handleInterrupt = useCallback(async (agent: FleetAgent) => {
    const surfaceId = agent.runtimeSurface?.id || agent.sessionKey || agent.id;
    if (!surfaceId) return;
    setInterruptingId(agent.id);
    try {
      await fetch('/api/runtime/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'interrupt',
          surfaceId,
        }),
      });
      setTimeout(() => { void fetchFleet(); }, 500);
    } catch {
      // silent
    } finally {
      setTimeout(() => setInterruptingId(null), 400);
    }
  }, [fetchFleet]);

  const handleOrchestratorRuntimeChange = useCallback((runtime: OrchestratorRuntime) => {
    setOrchestratorRuntime(runtime);
    writeOrchestratorRuntimePreference(runtime);
  }, []);

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 13 }}>
        Loading runtime inventory...
      </div>
    );
  }

  const squadMap = new Map(squads.map((squad) => [squad.id, squad]));
  const grouped = new Map<string, FleetAgent[]>();
  for (const agent of agents) {
    const key = agent.squadId || 'ungrouped';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(agent);
  }

  const [mcpInstalled, setMcpInstalled] = useState<boolean | null>(null);
  const [mcpInstalling, setMcpInstalling] = useState(false);
  const [mcpNote, setMcpNote] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/operator/install')
      .then(r => r.json())
      .then(data => setMcpInstalled(Boolean(data.installed)))
      .catch(() => setMcpInstalled(false));
  }, []);

  const handleInstallMcp = useCallback(async () => {
    setMcpInstalling(true);
    setMcpNote(null);
    try {
      const res = await fetch('/api/operator/install', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        setMcpInstalled(true);
        setMcpNote(data.note ?? 'Installed. Restart Claude Code to activate.');
      } else {
        setMcpNote(data.error ?? 'Install failed.');
      }
    } catch {
      setMcpNote('Unable to install MCP config.');
    } finally {
      setMcpInstalling(false);
    }
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Claude Code Connection */}
      <div style={{
        background: 'var(--t-panel)',
        borderRadius: 14,
        padding: 20,
        border: '1px solid var(--t-panel-border)',
        boxShadow: 'var(--t-panel-shadow)',
      }}>
        <div style={{ marginBottom: 14 }}>
          <h3 style={{ fontSize: 17, fontWeight: 700, color: 'var(--t-text)', margin: 0 }}>
            Claude Code Connection
          </h3>
          <p style={{ fontSize: 12, color: 'var(--t-text-muted)', margin: '4px 0 0', lineHeight: 1.5 }}>
            Connect your Claude Code terminal to o8. Gives Claude Code 5 operator tools: send tasks, check status, approve/reject, read history.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {mcpInstalled ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '6px 12px', borderRadius: 8,
                background: 'rgba(34, 197, 94, 0.08)', color: '#16a34a',
                fontSize: 12, fontWeight: 600,
              }}>
                <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                Connected
              </span>
              <button
                type="button"
                onClick={handleInstallMcp}
                disabled={mcpInstalling}
                style={{
                  border: 'none', background: 'transparent', color: 'var(--t-text-muted)',
                  fontSize: 11, cursor: 'pointer', padding: '4px 8px',
                }}
              >
                Reinstall
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleInstallMcp}
              disabled={mcpInstalling || mcpInstalled === null}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '8px 16px', borderRadius: 8,
                border: `1px solid ${THEME_ACCENT_BORDER}`,
                background: THEME_ACCENT_SOFT,
                color: THEME_ACCENT,
                fontSize: 12, fontWeight: 600, cursor: 'pointer',
              }}
            >
              {mcpInstalling ? 'Installing...' : 'Connect Claude Code'}
            </button>
          )}
        </div>
        {mcpNote ? (
          <p style={{ fontSize: 11, color: 'var(--t-text-muted)', margin: '8px 0 0', lineHeight: 1.4 }}>
            {mcpNote}
          </p>
        ) : null}
      </div>

      <div style={{
        background: 'var(--t-panel)',
        borderRadius: 14,
        padding: 20,
        border: '1px solid var(--t-panel-border)',
        boxShadow: 'var(--t-panel-shadow)',
      }}>
        <div style={{ marginBottom: 14 }}>
          <h3 style={{ fontSize: 17, fontWeight: 700, color: 'var(--t-text)', margin: 0 }}>
            Orchestrator Runtime
          </h3>
          <p style={{ fontSize: 12, color: 'var(--t-text-muted)', margin: '4px 0 0', lineHeight: 1.5 }}>
            `Cmd+J` mission control defaults new packets and live interventions to this CLI runtime.
          </p>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          {([
            { id: 'codex' as const, label: 'Codex', detail: 'Default planner runtime for packet launches and intervention lanes.' },
            { id: 'claude-code' as const, label: 'Claude Code', detail: 'Use Claude Code as the default orchestrator lane when Thoughts opens new work.' },
          ]).map((option) => {
            const active = orchestratorRuntime === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => handleOrchestratorRuntimeChange(option.id)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  padding: '14px 15px',
                  borderRadius: 12,
                  border: active ? `1.5px solid ${THEME_ACCENT_BORDER}` : '1px solid var(--t-panel-border)',
                  background: active ? THEME_ACCENT_SOFT : 'var(--t-bg-card, rgba(148, 163, 184, 0.08))',
                  cursor: 'pointer',
                  textAlign: 'left',
                  boxShadow: active ? `0 10px 24px ${THEME_ACCENT_RING}` : 'none',
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)' }}>
                  {option.label}
                </span>
                <span style={{ fontSize: 11, color: 'var(--t-text-muted)', lineHeight: 1.45 }}>
                  {option.detail}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{
        display: 'flex',
        gap: 16,
        padding: '14px 20px',
        borderRadius: 14,
        background: 'var(--t-panel)',
        border: '1px solid var(--t-panel-border)',
        boxShadow: 'var(--t-panel-shadow)',
      }}>
        <div style={{ textAlign: 'center', flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--t-text)' }}>{agents.length}</div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--t-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Agents</div>
        </div>
        <div style={{ width: 1, background: 'var(--t-divider)' }} />
        <div style={{ textAlign: 'center', flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#22c55e' }}>
            {agents.filter((agent) => agent.status === 'running').length}
          </div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--t-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Running</div>
        </div>
        <div style={{ width: 1, background: 'var(--t-divider)' }} />
        <div style={{ textAlign: 'center', flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#3b82f6' }}>{squads.length}</div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--t-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Squads</div>
        </div>
      </div>

      {Array.from(grouped.entries()).map(([squadId, members]) => {
        const squad = squadMap.get(squadId);
        return (
          <div key={squadId}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 10,
              paddingLeft: 4,
            }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)' }}>
                {squad?.name || squadId}
              </span>
              <span style={{
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--t-text-muted)',
                padding: '1px 8px',
                borderRadius: 5,
                background: 'var(--t-divider-subtle)',
              }}>
                {members.length}
              </span>
              {squad ? (
                <span style={{ fontSize: 10, color: 'var(--t-text-faint)', marginLeft: 'auto' }}>
                  {squad.throughputLabel}
                </span>
              ) : null}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {members.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  interrupting={interruptingId === agent.id}
                  onInterrupt={handleInterrupt}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
