'use client';

/**
 * AgentPanel — Left panel command center for Cortex IDE.
 *
 * Layout:
 *   Top: Agent status cards (always visible, never scroll)
 *   Middle: Tabbed content area (Activity / Issues / Files)
 *
 * Glass frost on dark aesthetic. Agent-first, file-tree secondary.
 */

import { memo, useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertCircle,
  BookOpen,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  GitCommit,
  GitPullRequest,
  Tag,
  Zap,
} from 'lucide-react';

// ── Types ──

interface Squad {
  id: string;
  name: string;
  status: string;
  liveSessions: number;
  alerts: number;
  throughputLabel: string;
}

interface CommitEntry {
  hash: string;
  message: string;
  age: string;
}

interface GHIssue {
  number: number;
  title: string;
  labels: { name: string; color: string }[];
  state?: string;
}

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

type Tab = 'activity' | 'issues' | 'files';

// ── Status colors ──

const statusDotColor: Record<string, string> = {
  watching: '#22c55e',
  healthy: '#22c55e',
  idle: '#f59e0b',
  offline: '#6b7280',
  unhealthy: '#ef4444',
  error: '#ef4444',
};

const statusLabel: Record<string, string> = {
  watching: 'running',
  healthy: 'active',
  idle: 'idle',
  offline: 'offline',
  unhealthy: 'error',
};

// ── Agent Card ──

const AgentCard = memo(function AgentCard({ squad }: { squad: Squad }) {
  const dotColor = statusDotColor[squad.status] ?? '#6b7280';
  const label = statusLabel[squad.status] ?? squad.status;

  return (
    <div style={{
      background: 'rgba(255, 255, 255, 0.06)',
      border: '1px solid rgba(255, 255, 255, 0.08)',
      borderRadius: 14,
      paddingTop: 12,
      paddingRight: 14,
      paddingBottom: 12,
      paddingLeft: 14,
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      transition: 'all 200ms ease',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Avatar circle */}
        <div style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: `linear-gradient(135deg, ${dotColor}33 0%, ${dotColor}11 100%)`,
          border: `1.5px solid ${dotColor}44`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 13,
          fontWeight: 700,
          color: dotColor,
          flexShrink: 0,
        }}>
          {squad.name[0]}
        </div>

        {/* Name + status */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              fontSize: 14,
              fontWeight: 600,
              color: '#f2f2f7',
              letterSpacing: '-0.01em',
            }}>{squad.name}</span>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              fontWeight: 500,
              color: dotColor,
              paddingTop: 2,
              paddingRight: 8,
              paddingBottom: 2,
              paddingLeft: 6,
              borderRadius: 99,
              background: `${dotColor}15`,
            }}>
              <span style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: dotColor,
                boxShadow: squad.status === 'watching' ? `0 0 6px ${dotColor}` : 'none',
              }} />
              {label}
            </span>
          </div>
          <div style={{
            fontSize: 12,
            color: '#64748b',
            marginTop: 3,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {squad.throughputLabel}
          </div>
        </div>

        {/* Alerts badge */}
        {squad.alerts > 0 ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            fontSize: 11,
            fontWeight: 600,
            color: '#ef4444',
          }}>
            <AlertCircle size={13} strokeWidth={2} />
            {squad.alerts}
          </div>
        ) : null}
      </div>
    </div>
  );
});

// ── Activity Feed ──

const ActivityFeed = memo(function ActivityFeed({ commits }: { commits: CommitEntry[] }) {
  if (!commits.length) {
    return <div style={{ padding: 20, fontSize: 13, color: '#475569' }}>No recent activity</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {commits.map((c, i) => (
        <div key={`${c.hash}-${i}`} style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          paddingTop: 10,
          paddingRight: 14,
          paddingBottom: 10,
          paddingLeft: 14,
          borderBottom: '1px solid rgba(255,255,255,0.04)',
        }}>
          <GitCommit size={14} strokeWidth={1.8} style={{ color: '#22c55e', marginTop: 2, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 13,
              color: '#e2e8f0',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {c.message}
            </div>
            <div style={{ fontSize: 11, color: '#475569', marginTop: 2 }}>
              <span style={{ fontFamily: 'SF Mono, ui-monospace, monospace', color: '#64748b' }}>{c.hash}</span>
              {' · '}{c.age}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
});

// ── Issues List ──

const IssuesList = memo(function IssuesList({ issues }: { issues: GHIssue[] }) {
  if (!issues.length) {
    return <div style={{ padding: 20, fontSize: 13, color: '#475569' }}>No open issues</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {issues.map((issue) => (
        <div key={issue.number} style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          paddingTop: 10,
          paddingRight: 14,
          paddingBottom: 10,
          paddingLeft: 14,
          borderBottom: '1px solid rgba(255,255,255,0.04)',
          cursor: 'pointer',
          transition: 'background 100ms ease',
        }}>
          <BookOpen size={14} strokeWidth={1.8} style={{ color: '#64748b', marginTop: 2, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: '#475569', fontWeight: 500 }}>#{issue.number}</span>
              <span style={{
                fontSize: 13,
                color: '#e2e8f0',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
              }}>
                {issue.title}
              </span>
            </div>
            {issue.labels.length > 0 ? (
              <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                {issue.labels.slice(0, 3).map((label) => (
                  <span key={label.name} style={{
                    fontSize: 10,
                    fontWeight: 600,
                    paddingTop: 1,
                    paddingRight: 6,
                    paddingBottom: 1,
                    paddingLeft: 6,
                    borderRadius: 99,
                    color: `#${label.color}`,
                    background: `#${label.color}18`,
                    border: `1px solid #${label.color}30`,
                    textTransform: 'uppercase',
                    letterSpacing: '0.03em',
                  }}>
                    {label.name.replace(/^(priority:|area:|phase:)/, '')}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
});

// ── File Tree ──

function FileTreeNode({ node, depth = 0 }: { node: FileNode; depth?: number }) {
  const [open, setOpen] = useState(depth === 0 || node.name === 'src');

  if (node.type === 'file') {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        paddingTop: 4,
        paddingRight: 14,
        paddingBottom: 4,
        paddingLeft: 14 + depth * 16,
        fontSize: 12,
        color: '#94a3b8',
        fontFamily: '"SF Mono", ui-monospace, monospace',
        cursor: 'pointer',
        transition: 'color 100ms',
      }}>
        <FileText size={13} strokeWidth={1.5} style={{ flexShrink: 0, color: '#475569' }} />
        {node.name}
      </div>
    );
  }

  return (
    <div>
      <div
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingTop: 4,
          paddingRight: 14,
          paddingBottom: 4,
          paddingLeft: 14 + depth * 16,
          fontSize: 12,
          fontWeight: 500,
          color: '#cbd5e1',
          cursor: 'pointer',
          transition: 'color 100ms',
        }}
      >
        {open
          ? <FolderOpen size={13} strokeWidth={1.5} style={{ flexShrink: 0, color: '#3b82f6' }} />
          : <Folder size={13} strokeWidth={1.5} style={{ flexShrink: 0, color: '#3b82f6' }} />
        }
        {node.name}
        {open
          ? <ChevronDown size={11} strokeWidth={2} style={{ color: '#475569' }} />
          : <ChevronRight size={11} strokeWidth={2} style={{ color: '#475569' }} />
        }
      </div>
      {open && node.children ? (
        node.children.map((child) => (
          <FileTreeNode key={child.path} node={child} depth={depth + 1} />
        ))
      ) : null}
    </div>
  );
}

const FileTree = memo(function FileTree({ tree }: { tree: FileNode[] }) {
  if (!tree.length) {
    return <div style={{ padding: 20, fontSize: 13, color: '#475569' }}>No files found</div>;
  }

  return (
    <div style={{ paddingTop: 6, paddingBottom: 6 }}>
      {tree.map((node) => (
        <FileTreeNode key={node.path} node={node} />
      ))}
    </div>
  );
});

// ── Tab Bar ──

const tabs: { id: Tab; icon: typeof Zap; label: string }[] = [
  { id: 'activity', icon: Zap, label: 'Activity' },
  { id: 'issues', icon: Tag, label: 'Issues' },
  { id: 'files', icon: Folder, label: 'Files' },
];

// ── Main Panel ──

export const AgentPanel = memo(function AgentPanel() {
  const [squads, setSquads] = useState<Squad[]>([]);
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [issues, setIssues] = useState<GHIssue[]>([]);
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>('activity');

  // Fetch agent inventory
  useEffect(() => {
    async function fetchAgents() {
      try {
        const res = await fetch('/api/runtime/inventory');
        if (!res.ok) return;
        const data = await res.json();
        // Filter to main agents only (not codex-local etc)
        const mainSquads = (data.squads ?? []).filter((s: Squad) =>
          !s.id.includes('codex-local') && !s.id.includes('codex-owned')
        );
        setSquads(mainSquads);
      } catch { /* silent */ }
    }
    void fetchAgents();
    const id = setInterval(fetchAgents, 30_000);
    return () => clearInterval(id);
  }, []);

  // Fetch recent commits
  useEffect(() => {
    async function fetchCommits() {
      try {
        const res = await fetch('/api/review/workspace');
        if (!res.ok) return;
        const data = await res.json();
        const raw: string[] = data.recentCommits ?? [];
        setCommits(raw.map((line) => {
          const spaceIdx = line.indexOf(' ');
          const hash = line.slice(0, spaceIdx);
          const rest = line.slice(spaceIdx + 1);
          const ageMatch = rest.match(/\(([^)]+)\)$/);
          const message = ageMatch ? rest.slice(0, ageMatch.index).trim() : rest;
          const age = ageMatch ? ageMatch[1] : '';
          return { hash, message, age };
        }));
      } catch { /* silent */ }
    }
    void fetchCommits();
  }, []);

  // Fetch GitHub issues
  useEffect(() => {
    async function fetchIssues() {
      try {
        const res = await fetch('/api/panel/issues');
        if (!res.ok) return;
        const data = await res.json();
        setIssues(data.issues ?? []);
      } catch { /* silent */ }
    }
    void fetchIssues();
  }, []);

  // Fetch file tree
  useEffect(() => {
    async function fetchFiles() {
      try {
        const res = await fetch('/api/panel/files');
        if (!res.ok) return;
        const data = await res.json();
        setFileTree(data.tree ?? []);
      } catch { /* silent */ }
    }
    void fetchFiles();
  }, []);

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* ── Agent Cards (pinned top) ── */}
      <div style={{
        flexShrink: 0,
        paddingTop: 16,
        paddingRight: 14,
        paddingBottom: 8,
        paddingLeft: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}>
        <div style={{
          fontSize: 11,
          fontWeight: 700,
          color: '#475569',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          paddingLeft: 2,
          marginBottom: 2,
        }}>
          Agents
        </div>
        {squads.length === 0 ? (
          <div style={{ fontSize: 13, color: '#475569', padding: '8px 2px' }}>Loading agents…</div>
        ) : (
          squads.map((squad) => (
            <AgentCard key={squad.id} squad={squad} />
          ))
        )}
      </div>

      {/* ── Tab Bar ── */}
      <div style={{
        display: 'flex',
        gap: 2,
        paddingTop: 8,
        paddingRight: 14,
        paddingBottom: 0,
        paddingLeft: 14,
        flexShrink: 0,
      }}>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                paddingTop: 8,
                paddingRight: 0,
                paddingBottom: 8,
                paddingLeft: 0,
                border: 'none',
                borderBottom: isActive ? '2px solid #ef4444' : '2px solid transparent',
                background: 'transparent',
                color: isActive ? '#f2f2f7' : '#475569',
                fontSize: 12,
                fontWeight: isActive ? 600 : 400,
                cursor: 'pointer',
                transition: 'all 150ms ease',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}
            >
              <Icon size={14} strokeWidth={isActive ? 2 : 1.5} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* ── Content Area (scrollable) ── */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        borderTop: '1px solid rgba(255,255,255,0.04)',
        marginTop: 4,
      }}>
        {activeTab === 'activity' ? <ActivityFeed commits={commits} /> : null}
        {activeTab === 'issues' ? <IssuesList issues={issues} /> : null}
        {activeTab === 'files' ? <FileTree tree={fileTree} /> : null}
      </div>
    </div>
  );
});
