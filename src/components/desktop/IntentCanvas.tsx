'use client';
/* eslint-disable @typescript-eslint/no-unused-vars -- design surface keeps dormant hooks during iterative build-out */

/**
 * IntentCanvas — 2027 Agent Orchestration Command Center
 *
 * Renders in the center workspace when "Intent" nav is active.
 * Parallel lanes: Human (center, wider) flanked by agent lanes.
 * Each lane shows real-time activity stream.
 *
 * Phase 1 (V0): Static layout with mock data.
 * Future: Live data, cross-lane connections, confidence meter.
 */

import { useState, useMemo, useCallback } from 'react';

// ── Types ──

interface AgentLane {
  name: string;
  model: string;
  status: 'active' | 'idle' | 'reviewing' | 'coding';
  contextPct: number;
  currentTask: string;
  queueDepth: number;
  color: string;
  activities: Activity[];
}

interface Activity {
  type: 'commit' | 'pr' | 'review' | 'task' | 'thinking' | 'error' | 'handoff';
  text: string;
  time: string;
  meta?: string;
}

interface Handoff {
  from: string;
  to: string;
  label: string;
  status: 'active' | 'complete' | 'pending';
}

// ── Mock Data ──

const AGENTS: AgentLane[] = [
  {
    name: 'MISTER',
    model: 'Opus',
    status: 'active',
    contextPct: 45,
    currentTask: 'IDE Development — Session Timeline',
    queueDepth: 0,
    color: '#2563eb',
    activities: [
      { type: 'commit', text: 'fix: Timeline hover alignment', time: '1:26 PM', meta: 'feeac14' },
      { type: 'commit', text: 'fix: Coding dominance in merge', time: '1:20 PM', meta: '7728910' },
      { type: 'commit', text: 'fix: Classifier — toolResult = coding', time: '1:15 PM', meta: 'a4fcd38' },
      { type: 'commit', text: 'feat: SessionTimeline Phase 1', time: '12:51 PM', meta: '6da96c2' },
      { type: 'commit', text: 'feat: Timeline Expanded View', time: '12:43 PM', meta: '01ace93' },
      { type: 'thinking', text: 'Planning orchestration mockups', time: '1:54 PM' },
    ],
  },
  {
    name: 'NIOT',
    model: 'Codex',
    status: 'idle',
    contextPct: 22,
    currentTask: 'Awaiting next Cortex task',
    queueDepth: 0,
    color: '#22c55e',
    activities: [
      { type: 'pr', text: 'PR #348 — Phone regex suppression', time: '11:40 AM', meta: 'merged' },
      { type: 'pr', text: 'PR #347 — Governor tightening', time: '11:20 AM', meta: 'merged' },
      { type: 'task', text: 'Completed governor 4-phase spec', time: '10:50 AM' },
      { type: 'handoff', text: 'Handed off PR #347 → Hawk for review', time: '11:15 AM' },
    ],
  },
  {
    name: 'HAWK',
    model: 'Codex',
    status: 'idle',
    contextPct: 15,
    currentTask: 'Awaiting PR for review',
    queueDepth: 0,
    color: '#f59e0b',
    activities: [
      { type: 'review', text: 'Approved PR #348', time: '11:35 AM', meta: '✓' },
      { type: 'review', text: 'Approved PR #347', time: '11:25 AM', meta: '✓' },
      { type: 'review', text: 'QA sweep scan #110', time: '11:16 AM' },
    ],
  },
];

const HANDOFFS: Handoff[] = [
  { from: 'MISTER', to: 'NIOT', label: 'Issue #346 → Governor spec', status: 'complete' },
  { from: 'NIOT', to: 'HAWK', label: 'PR #347 → Review', status: 'complete' },
  { from: 'NIOT', to: 'HAWK', label: 'PR #348 → Review', status: 'complete' },
];

const TASK_QUEUE = [
  { issue: '#112', title: 'Wire timeline to real gateway data', suggested: 'MISTER', priority: 'p1' },
  { issue: '#113', title: 'Session picker in expanded view', suggested: 'MISTER', priority: 'p2' },
  { issue: '#99', title: 'Real-time WebSocket streaming', suggested: 'NIOT', priority: 'p1' },
  { issue: '#110', title: 'Desktop chat send escaping bug', suggested: 'NIOT', priority: 'p0' },
  { issue: '#109', title: 'Outbound alert delivery', suggested: 'MISTER', priority: 'p1' },
];

// ── SVG Icons (inline for Tauri) ──

function CommitIcon() {
  return <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}><circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/></svg>;
}

function PRIcon() {
  return <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg>;
}

function CheckIcon() {
  return <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}><polyline points="20 6 9 17 4 12"/></svg>;
}

function TaskIcon() {
  return <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 12l2 2 4-4"/></svg>;
}

function BrainIcon() {
  return <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}><path d="M12 2a7 7 0 0 0-7 7c0 3 2 5 4 7l3 4 3-4c2-2 4-4 4-7a7 7 0 0 0-7-7z"/></svg>;
}

function ArrowRightIcon() {
  return <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>;
}

function PlusIcon() {
  return <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;
}

// ── Activity Icon ──

function ActivityIcon({ type }: { type: Activity['type'] }) {
  switch (type) {
    case 'commit': return <CommitIcon />;
    case 'pr': return <PRIcon />;
    case 'review': return <CheckIcon />;
    case 'task': return <TaskIcon />;
    case 'thinking': return <BrainIcon />;
    case 'handoff': return <ArrowRightIcon />;
    default: return <TaskIcon />;
  }
}

// ── Progress Ring ──

function ProgressRing({ pct, color, size = 56 }: { pct: number; color: string; size?: number }) {
  const r = (size - 8) / 2;
  const circ = 2 * Math.PI * r;
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--t-divider-subtle)" strokeWidth="4" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="4"
          strokeDasharray={`${(pct / 100) * circ} ${circ}`}
          strokeLinecap="round"
        />
      </svg>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 13, fontWeight: 700, color: 'var(--t-text)',
      }}>
        {pct}%
      </div>
    </div>
  );
}

// ── Agent Lane ──

function AgentLaneCard({ agent }: { agent: AgentLane }) {
  const statusColors: Record<string, string> = {
    active: '#22c55e', idle: '#9ca3af', reviewing: '#f59e0b', coding: '#2563eb',
  };
  const statusColor = statusColors[agent.status] || '#9ca3af';

  return (
    <div style={{
      flex: 1,
      minWidth: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      height: '100%',
    }}>
      {/* Agent header card */}
      <div style={{
        background: 'var(--t-panel)',
        borderRadius: 14,
        padding: 16,
        border: '1px solid var(--t-panel-border)',
        boxShadow: 'var(--t-panel-shadow)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <ProgressRing pct={agent.contextPct} color={agent.color} size={48} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--t-text)' }}>{agent.name}</span>
              <span style={{ fontSize: 10, color: 'var(--t-text-muted)', fontWeight: 500 }}>({agent.model})</span>
              <div style={{
                width: 6, height: 6, borderRadius: 3, background: statusColor, flexShrink: 0,
              }} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--t-text-secondary)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {agent.currentTask}
            </div>
            <div style={{ fontSize: 10, color: 'var(--t-text-muted)', marginTop: 2 }}>
              Queue: {agent.queueDepth} tasks · ctx {agent.contextPct}%
            </div>
          </div>
        </div>
      </div>

      {/* Activity stream */}
      <div style={{
        flex: 1,
        background: 'var(--t-panel)',
        borderRadius: 14,
        padding: 12,
        border: '1px solid var(--t-panel-border)',
        overflow: 'auto',
      }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--t-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
          Activity
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {agent.activities.map((act, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0',
              borderBottom: i < agent.activities.length - 1 ? '1px solid var(--t-divider-subtle)' : 'none',
            }}>
              <div style={{ color: agent.color, marginTop: 1 }}>
                <ActivityIcon type={act.type} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--t-text)', lineHeight: 1.4 }}>{act.text}</div>
                <div style={{ fontSize: 9, color: 'var(--t-text-faint)', marginTop: 1 }}>
                  {act.time}{act.meta ? ` · ${act.meta}` : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Main Component ──

export function IntentCanvas() {
  return (
    <div style={{
      height: '100%',
      overflow: 'auto',
      padding: 20,
      background: 'var(--t-bg)',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
    }}>
      {/* Fleet Status Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--t-text)', margin: 0 }}>
            Fleet Command
          </h2>
          <p style={{ fontSize: 11, color: 'var(--t-text-muted)', margin: '2px 0 0' }}>
            3 agents · 2 idle · 1 active · {TASK_QUEUE.length} queued
          </p>
        </div>
        <button
          type="button"
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 14px', borderRadius: 10, border: 'none',
            background: '#2563eb', color: '#fff', fontSize: 12, fontWeight: 600,
            cursor: 'pointer', transition: 'background 120ms',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = '#1d4ed8'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = '#2563eb'; }}
        >
          <PlusIcon /> Assign Task
        </button>
      </div>

      {/* Agent Lanes — parallel columns */}
      <div style={{
        display: 'flex',
        gap: 12,
        flex: 1,
        minHeight: 0,
      }}>
        {AGENTS.map((agent) => (
          <AgentLaneCard key={agent.name} agent={agent} />
        ))}
      </div>

      {/* Bottom section: Handoffs + Task Queue side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr', gap: 12 }}>
        {/* Handoffs */}
        <div style={{
          background: 'var(--t-panel)',
          borderRadius: 14,
          padding: 16,
          border: '1px solid var(--t-panel-border)',
        }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--t-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 10 }}>
            Recent Handoffs
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {HANDOFFS.map((h, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 8, fontSize: 11,
              }}>
                <span style={{ fontWeight: 600, color: AGENTS.find(a => a.name === h.from)?.color || 'var(--t-text)' }}>{h.from}</span>
                <ArrowRightIcon />
                <span style={{ fontWeight: 600, color: AGENTS.find(a => a.name === h.to)?.color || 'var(--t-text)' }}>{h.to}</span>
                <span style={{ color: 'var(--t-text-secondary)', flex: 1 }}>{h.label}</span>
                <span style={{
                  fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
                  color: h.status === 'complete' ? '#22c55e' : h.status === 'active' ? '#2563eb' : 'var(--t-text-muted)',
                }}>{h.status}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Task Queue */}
        <div style={{
          background: 'var(--t-panel)',
          borderRadius: 14,
          padding: 16,
          border: '1px solid var(--t-panel-border)',
        }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--t-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 10 }}>
            Task Queue
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {TASK_QUEUE.map((task, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0',
                borderBottom: i < TASK_QUEUE.length - 1 ? '1px solid var(--t-divider-subtle)' : 'none',
              }}>
                <span style={{
                  fontSize: 9, fontWeight: 700, textTransform: 'uppercase', padding: '2px 6px', borderRadius: 4,
                  background: task.priority === 'p0' ? 'rgba(239,68,68,0.1)' : task.priority === 'p1' ? 'rgba(37,99,235,0.1)' : 'var(--t-divider-subtle)',
                  color: task.priority === 'p0' ? '#ef4444' : task.priority === 'p1' ? '#2563eb' : 'var(--t-text-muted)',
                }}>
                  {task.priority}
                </span>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text)' }}>{task.issue}</span>
                <span style={{ fontSize: 11, color: 'var(--t-text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</span>
                <span style={{
                  fontSize: 10, fontWeight: 500, padding: '2px 8px', borderRadius: 6,
                  background: `${AGENTS.find(a => a.name === task.suggested)?.color || '#9ca3af'}15`,
                  color: AGENTS.find(a => a.name === task.suggested)?.color || 'var(--t-text-muted)',
                }}>
                  → {task.suggested}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
