'use client';

import type { OrchestratorMissionState } from '@/lib/orchestrator/types';
import type { RepoIssue, RepoIssuesGroup } from './types';

interface IssueGroupListProps {
  issueGroups: RepoIssuesGroup[];
  issueGroupCollapsed: Record<string, boolean>;
  setIssueGroupCollapsed: (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => void;
  focusedRepoId?: string | null;
  missionState: OrchestratorMissionState;
  onCreatePacketFromIssue: (issue: RepoIssue) => void;
}

export function IssueGroupList({
  issueGroups,
  issueGroupCollapsed,
  setIssueGroupCollapsed,
  focusedRepoId,
  missionState,
  onCreatePacketFromIssue,
}: IssueGroupListProps) {
  return (
    <>
      {issueGroups.map((group) => {
        const collapsed = issueGroupCollapsed[group.repoId] ?? (focusedRepoId ? group.repoId !== focusedRepoId : false);
        const isFocused = group.repoId === focusedRepoId;
        return (
          <div key={group.repoId} style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            <button
              type="button"
              onClick={() => setIssueGroupCollapsed((prev) => ({ ...prev, [group.repoId]: !collapsed }))}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                height: 28,
                paddingTop: 0,
                paddingRight: 8,
                paddingBottom: 0,
                paddingLeft: 8,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                position: 'sticky',
                top: 0,
                zIndex: 1,
              }}
            >
              <span style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase' as const,
                letterSpacing: '0.05em',
                color: isFocused ? 'var(--t-text)' : 'var(--t-text-muted)',
              }}>
                {group.repoName}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  padding: '1px 6px',
                  borderRadius: 999,
                  background: 'var(--t-divider-subtle)',
                  color: 'var(--t-text-secondary)',
                  fontSize: 10,
                  fontWeight: 700,
                }}>
                  {group.issues.length}
                </span>
                <svg width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="var(--t-text-muted)" strokeWidth="1.5" strokeLinecap="round" style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 150ms ease' }}>
                  <path d="M2.5 3.5L5 6L7.5 3.5" />
                </svg>
              </div>
            </button>
            {!collapsed ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {group.issues.map((issue) => {
                  const alreadyPacketed = missionState.packets.some(
                    (packet) => packet.summary.includes(`#${issue.number}`) || packet.title === issue.title,
                  );
                  return (
                    <div
                      key={`${group.repoId}-${issue.number}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        height: 34,
                        paddingTop: 0,
                        paddingRight: 8,
                        paddingBottom: 0,
                        paddingLeft: 8,
                        transition: 'background 120ms ease',
                      }}
                      onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-divider-subtle)'; }}
                      onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                    >
                      <span style={{ width: 42, flexShrink: 0, fontSize: 10, fontWeight: 700, color: 'var(--t-text-muted)', fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)' }}>
                        #{issue.number}
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--t-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {issue.title}
                      </span>
                      {!alreadyPacketed ? (
                        <button type="button" onClick={() => onCreatePacketFromIssue(issue)} title="Create work packet"
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '2px 4px', flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                          <span style={{ fontSize: 14, color: 'var(--t-text-muted)', opacity: 0.5, lineHeight: 1 }}>+</span>
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
