'use client';

import { useEffect, useRef, useState } from 'react';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';
import type { RepoIssue, RepoIssuesGroup } from './types';

// #867 — Two-step confirm window. First click on "+" arms the row; second
// click within this window actually dispatches. Auto-cancels after the
// timeout so an idle armed row doesn't sit hot indefinitely.
const CONFIRM_TIMEOUT_MS = 5000;

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
  // #867 — Track which issue row is currently armed for dispatch. Only one
  // row can be armed at a time; clicking another row's "+" cancels the
  // previous arm. Key shape: `${repoId}::${issueNumber}`.
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending arm-timer on unmount so we don't fire setState on a
  // gone component.
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  const armConfirm = (key: string) => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    setConfirmingKey(key);
    confirmTimerRef.current = setTimeout(() => {
      setConfirmingKey((current) => (current === key ? null : current));
      confirmTimerRef.current = null;
    }, CONFIRM_TIMEOUT_MS);
  };

  const cancelConfirm = () => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = null;
    setConfirmingKey(null);
  };

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
                <svg width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="var(--t-text-muted)" strokeWidth="1.5" strokeLinecap="round" style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 150ms cubic-bezier(0.22, 1, 0.36, 1)' }}>
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
                  const issueKey = `${group.repoId}::${issue.number}`;
                  const isConfirming = confirmingKey === issueKey;
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
                        transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
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
                        isConfirming ? (
                          // #867 — Inline confirm strip. Two buttons: confirm
                          // (orange accent, dispatches) and cancel (neutral,
                          // disarms). Auto-disarms after CONFIRM_TIMEOUT_MS.
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 4,
                              flexShrink: 0,
                            }}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                cancelConfirm();
                                onCreatePacketFromIssue(issue);
                              }}
                              title="Confirm dispatch"
                              style={{
                                borderWidth: 1,
                                borderStyle: 'solid',
                                borderColor: 'rgba(255, 90, 31, 0.45)',
                                background: 'rgba(255, 90, 31, 0.12)',
                                color: '#c2410c',
                                cursor: 'pointer',
                                paddingTop: 2,
                                paddingRight: 8,
                                paddingBottom: 2,
                                paddingLeft: 8,
                                borderRadius: 6,
                                fontSize: 10,
                                fontWeight: 700,
                                letterSpacing: '0.04em',
                                textTransform: 'uppercase' as const,
                                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                              }}
                            >
                              Dispatch
                            </button>
                            <button
                              type="button"
                              onClick={cancelConfirm}
                              title="Cancel"
                              style={{
                                borderWidth: 1,
                                borderStyle: 'solid',
                                borderColor: 'var(--t-border)',
                                background: 'transparent',
                                color: 'var(--t-text-secondary)',
                                cursor: 'pointer',
                                paddingTop: 2,
                                paddingRight: 8,
                                paddingBottom: 2,
                                paddingLeft: 8,
                                borderRadius: 6,
                                fontSize: 10,
                                fontWeight: 600,
                                letterSpacing: '0.04em',
                                textTransform: 'uppercase' as const,
                                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => armConfirm(issueKey)}
                            title="Create work packet"
                            style={{
                              borderWidth: 0,
                              background: 'transparent',
                              cursor: 'pointer',
                              paddingTop: 2,
                              paddingRight: 4,
                              paddingBottom: 2,
                              paddingLeft: 4,
                              flexShrink: 0,
                              display: 'flex',
                              alignItems: 'center',
                            }}
                          >
                            <span style={{ fontSize: 14, color: 'var(--t-text-muted)', opacity: 0.5, lineHeight: 1 }}>+</span>
                          </button>
                        )
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
