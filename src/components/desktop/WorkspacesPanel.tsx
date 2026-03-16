'use client';

/**
 * WorkspacesPanel — Status-grouped workspace cards.
 * Lives above AgentPanel in the left sidebar.
 * Collapsible to just "WORKSPACES" header.
 */

import { useState, useCallback } from 'react';

// ── Types ──

type WorkspaceStatus = 'in_progress' | 'awaiting_review' | 'done' | 'backlog';

interface TimelineSegment {
  kind: 'coding' | 'thinking' | 'testing' | 'error' | 'idle';
  fraction: number; // 0-1
}

interface WorkspaceCard {
  id: string;
  repo: string;
  branch?: string;
  agent?: string;
  agentColor?: string;
  status: WorkspaceStatus;
  timeline?: TimelineSegment[];
  diffAdded?: number;
  diffRemoved?: number;
  progress?: number; // 0-1
  prNumber?: number;
  prTitle?: string;
  merged?: boolean;
}

// ── Mock Data ──

const MOCK_WORKSPACES: WorkspaceCard[] = [
  {
    id: 'ws-1',
    repo: 'cortex-ide',
    branch: 'feat/workspace-panel',
    agent: 'Niot',
    agentColor: '#2563eb',
    status: 'in_progress',
    timeline: [
      { kind: 'coding', fraction: 0.45 },
      { kind: 'coding', fraction: 0.2 },
      { kind: 'thinking', fraction: 0.15 },
      { kind: 'testing', fraction: 0.1 },
      { kind: 'idle', fraction: 0.1 },
    ],
    diffAdded: 420,
    diffRemoved: 25,
    progress: 0.65,
  },
  {
    id: 'ws-2',
    repo: 'cortex',
    branch: 'fix/governor-tuning',
    agent: 'Hawk',
    agentColor: '#f59e0b',
    status: 'in_progress',
    timeline: [
      { kind: 'coding', fraction: 0.6 },
      { kind: 'thinking', fraction: 0.15 },
      { kind: 'coding', fraction: 0.15 },
      { kind: 'testing', fraction: 0.1 },
    ],
    diffAdded: 150,
    diffRemoved: 12,
    progress: 0.4,
  },
  {
    id: 'ws-3',
    repo: 'cortex-ide',
    status: 'awaiting_review',
    prNumber: 349,
    prTitle: 'feat: approval routing in Thoughts Card',
    diffAdded: 706,
    diffRemoved: 36,
  },
  {
    id: 'ws-4',
    repo: 'cortex',
    status: 'done',
    prNumber: 348,
    prTitle: 'fix: phone regex suppression',
    merged: true,
  },
  {
    id: 'ws-5',
    repo: 'cortex',
    status: 'done',
    prNumber: 347,
    prTitle: 'feat: auto-capture governor tightening',
    merged: true,
  },
];

// ── Color map ──

const TIMELINE_COLORS: Record<string, string> = {
  coding: '#2563eb',
  thinking: '#93c5fd',
  testing: '#f59e0b',
  error: '#ef4444',
  idle: '#e5e7eb',
};

// ── SVG Icons ──

function GitHubIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
    </svg>
  );
}

function PRIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/>
      <path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/>
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" fill="#22c55e"/>
      <polyline points="9 12 11 14 15 10" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{
      display: 'block', flexShrink: 0, transition: 'transform 200ms cubic-bezier(0.32, 0.72, 0, 1)',
      transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
    }}>
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  );
}

// ── Progress Ring ──

function ProgressRing({ progress, size = 20 }: { progress: number; size?: number }) {
  const r = (size - 3) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - progress);

  return (
    <svg width={size} height={size} style={{ display: 'block', flexShrink: 0, transform: 'rotate(-90deg)' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(0,0,0,0.06)" strokeWidth={2.5} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#2563eb" strokeWidth={2.5}
        strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset 600ms cubic-bezier(0.32, 0.72, 0, 1)' }}
      />
    </svg>
  );
}

// ── Mini Timeline Bar ──

function MiniTimeline({ segments }: { segments: TimelineSegment[] }) {
  return (
    <div style={{
      display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden',
      width: 80, flexShrink: 0, background: 'rgba(0,0,0,0.04)',
    }}>
      {segments.map((seg, i) => (
        <div key={i} style={{
          flex: seg.fraction,
          background: TIMELINE_COLORS[seg.kind] || '#e5e7eb',
          borderRight: i < segments.length - 1 ? '0.5px solid rgba(255,255,255,0.5)' : 'none',
        }} />
      ))}
    </div>
  );
}

// ── Status Section ──

const STATUS_LABELS: Record<WorkspaceStatus, string> = {
  in_progress: 'In Progress',
  awaiting_review: 'Awaiting Review',
  done: 'Done',
  backlog: 'Backlog',
};

function StatusSection({ status, cards }: { status: WorkspaceStatus; cards: WorkspaceCard[] }) {
  if (cards.length === 0) return null;

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: '#6b7280',
        marginBottom: 6, padding: '0 2px',
        letterSpacing: '-0.01em',
      }}>
        {STATUS_LABELS[status]}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {cards.map(card => (
          <WorkspaceCardView key={card.id} card={card} />
        ))}
      </div>
    </div>
  );
}

// ── Workspace Card ──

function WorkspaceCardView({ card }: { card: WorkspaceCard }) {
  if (card.status === 'done') {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 12px', borderRadius: 12,
        background: 'rgba(0,0,0,0.02)',
        border: '1px solid rgba(0,0,0,0.04)',
        cursor: 'pointer',
        transition: 'background 120ms',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.04)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.02)'; }}
      >
        <CheckCircleIcon />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 12, fontWeight: 600, color: '#374151',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {card.prTitle || card.repo}
          </div>
          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 1 }}>
            Merged PR #{card.prNumber}
          </div>
        </div>
      </div>
    );
  }

  if (card.status === 'awaiting_review') {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 12px', borderRadius: 12,
        background: 'rgba(37, 99, 235, 0.03)',
        border: '1px solid rgba(37, 99, 235, 0.08)',
        cursor: 'pointer',
        transition: 'background 120ms',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(37, 99, 235, 0.06)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(37, 99, 235, 0.03)'; }}
      >
        <div style={{ color: '#6b7280' }}><PRIcon /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 12, fontWeight: 600, color: '#374151',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            PR #{card.prNumber}: {card.prTitle}
          </div>
        </div>
        {(card.diffAdded || card.diffRemoved) && (
          <span style={{ fontSize: 10, fontWeight: 600, fontFamily: 'SF Mono, Menlo, monospace', flexShrink: 0 }}>
            <span style={{ color: '#22c55e' }}>+{card.diffAdded}</span>
            {' '}
            <span style={{ color: '#ef4444' }}>-{card.diffRemoved}</span>
          </span>
        )}
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button type="button" style={{
            padding: '4px 10px', borderRadius: 8, border: 'none',
            background: '#22c55e', color: '#fff',
            fontSize: 10, fontWeight: 700, cursor: 'pointer',
          }}>
            Approve
          </button>
          <button type="button" style={{
            padding: '4px 10px', borderRadius: 8,
            border: '1px solid rgba(239, 68, 68, 0.2)',
            background: 'rgba(239, 68, 68, 0.06)', color: '#ef4444',
            fontSize: 10, fontWeight: 700, cursor: 'pointer',
          }}>
            Reject
          </button>
        </div>
      </div>
    );
  }

  // In Progress / Backlog
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '10px 12px', borderRadius: 12,
      background: 'rgba(0,0,0,0.02)',
      border: '1px solid rgba(0,0,0,0.05)',
      cursor: 'pointer',
      transition: 'background 120ms',
    }}
    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.04)'; }}
    onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.02)'; }}
    >
      <div style={{ color: '#6b7280' }}><GitHubIcon /></div>
      <div style={{
        fontSize: 12, fontWeight: 600, color: '#111827',
        letterSpacing: '-0.01em', flexShrink: 0,
      }}>
        {card.repo}
      </div>
      {card.branch && (
        <span style={{
          fontSize: 9, fontWeight: 500, color: '#6b7280',
          padding: '2px 6px', borderRadius: 5,
          background: 'rgba(0,0,0,0.04)',
          fontFamily: 'SF Mono, Menlo, monospace',
          maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          flexShrink: 1,
        }}>
          {card.branch}
      </span>
      )}
      {card.agent && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: card.agentColor || '#9ca3af',
            display: 'block',
          }} />
          <span style={{ fontSize: 11, fontWeight: 600, color: '#374151' }}>
            {card.agent}
          </span>
        </div>
      )}
      {card.timeline && <MiniTimeline segments={card.timeline} />}
      {(card.diffAdded || card.diffRemoved) && (
        <span style={{ fontSize: 10, fontWeight: 600, fontFamily: 'SF Mono, Menlo, monospace', flexShrink: 0 }}>
          <span style={{ color: '#22c55e' }}>+{card.diffAdded}</span>
          {' '}
          <span style={{ color: '#ef4444' }}>-{card.diffRemoved}</span>
        </span>
      )}
      {card.progress !== undefined && (
        <ProgressRing progress={card.progress} />
      )}
    </div>
  );
}

// ── Main Component ──

export function WorkspacesPanel() {
  const [collapsed, setCollapsed] = useState(false);
  const workspaces = MOCK_WORKSPACES;

  const grouped = {
    in_progress: workspaces.filter(w => w.status === 'in_progress'),
    awaiting_review: workspaces.filter(w => w.status === 'awaiting_review'),
    done: workspaces.filter(w => w.status === 'done'),
    backlog: workspaces.filter(w => w.status === 'backlog'),
  };

  const toggleCollapse = useCallback(() => setCollapsed(v => !v), []);

  return (
    <div style={{
      borderBottom: '1px solid rgba(0,0,0,0.06)',
      fontFamily: '-apple-system, system-ui, BlinkMacSystemFont, sans-serif',
    }}>
      {/* Header */}
      <button
        type="button"
        onClick={toggleCollapse}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 6,
          padding: '12px 14px',
          background: 'none', border: 'none', cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <ChevronIcon collapsed={collapsed} />
        <span style={{
          fontSize: 11, fontWeight: 800, color: '#111827',
          letterSpacing: '0.06em', textTransform: 'uppercase',
          flex: 1,
        }}>
          Workspaces
        </span>
        <span style={{
          fontSize: 10, fontWeight: 600, color: '#9ca3af',
          padding: '1px 6px', borderRadius: 5,
          background: 'rgba(0,0,0,0.04)',
        }}>
          {workspaces.filter(w => w.status === 'in_progress').length} active
        </span>
      </button>

      {/* Body */}
      {!collapsed && (
        <div style={{
          padding: '0 12px 12px',
          transition: 'max-height 250ms cubic-bezier(0.32, 0.72, 0, 1)',
        }}>
          <StatusSection status="in_progress" cards={grouped.in_progress} />
          <StatusSection status="done" cards={grouped.done} />
          <StatusSection status="backlog" cards={grouped.backlog} />
        </div>
      )}
    </div>
  );
}
