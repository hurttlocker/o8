'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  OrchestratorLaneBinding,
  OrchestratorMissionState,
  OrchestratorPacket,
  OrchestratorRuntime,
  OrchestratorWorkspaceTarget,
} from '@/lib/orchestrator/types';
import type { AgentTarget } from './types';
import { createDraftPacket } from './utils';
import type {
  EditingField,
  RepoIssue,
  RepoIssuesGroup,
  ReviewPanelState,
} from './mission-panel/types';
import {
  clearPacketBranchBlockedReason,
  fetchPacketBranches,
  findCurrentPacketBranch,
  hasPacketBranchTarget,
  PACKET_BRANCH_REQUIRED_REASON,
} from './mission-panel/branchTarget';
import { IssueGroupList } from './mission-panel/IssueGroupList';
import { PacketCard } from './mission-panel/PacketCard';

export function ThoughtsMissionPanel({
  open,
  visible,
  missionState,
  workspaceTargets,
  preferredRuntime,
  thoughtsBodyBackground,
  onMissionStateChange,
  onLaunchPacket,
  onFocusPacket,
  focusedRepoId,
}: {
  open: boolean;
  visible: boolean;
  missionState: OrchestratorMissionState;
  workspaceTargets: OrchestratorWorkspaceTarget[];
  preferredRuntime: OrchestratorRuntime;
  sessionTargets: AgentTarget[];
  thoughtsBodyBackground: string;
  thoughtsElevatedSurface: string;
  thoughtsElevatedBorder: string;
  thoughtsElevatedShadow: string;
  thoughtsMutedGlass: string;
  onMissionStateChange: (
    next: OrchestratorMissionState | ((current: OrchestratorMissionState) => OrchestratorMissionState)
  ) => void;
  onLaunchPacket?: (packet: OrchestratorPacket) => Promise<OrchestratorLaneBinding | null> | OrchestratorLaneBinding | null;
  onFocusPacket?: (packet: OrchestratorPacket) => void;
  focusedRepoId?: string | null;
}) {
  const [issueGroups, setIssueGroups] = useState<RepoIssuesGroup[]>([]);
  const [issueGroupCollapsed, setIssueGroupCollapsed] = useState<Record<string, boolean>>({});
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [expandedPacketId, setExpandedPacketId] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<EditingField>(null);
  const [reviewStateByPacketId, setReviewStateByPacketId] = useState<Record<string, ReviewPanelState>>({});
  const branchAutofillAttemptRef = useRef<Record<string, string>>({});
  const branchRequestByRepoPathRef = useRef<Record<string, Promise<Awaited<ReturnType<typeof fetchPacketBranches>>>>>({});

  // Close editing field on Escape or click outside any row in the
  // expanded packet card.
  useEffect(() => {
    if (!editingField) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setEditingField(null);
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (!target.closest('[data-packet-row]')) {
        setEditingField(null);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [editingField]);

  // Auto-expand focused repo when it changes
  useEffect(() => {
    if (focusedRepoId) setIssueGroupCollapsed((prev) => ({ ...prev, [focusedRepoId]: false }));
  }, [focusedRepoId]);

  useEffect(() => {
    if (!open || !visible) return;

    let cancelled = false;

    const fetchAllIssues = async (fresh: boolean) => {
      try {
        setIssuesLoading(true);
        const reposRes = await fetch('/api/panel/repos');
        if (!reposRes.ok || cancelled) { setIssuesLoading(false); return; }
        const reposData = await reposRes.json() as { repos?: Array<{ id: string; name: string; localPath: string; remoteUrl?: string }> };
        const repos = reposData.repos ?? [];

        const groups = await Promise.all(repos.map(async (repo) => {
          if (!repo.remoteUrl) return null;
          const slug = repo.remoteUrl.replace(/\.git$/, '').split('/').slice(-2).join('/');
          if (!slug || slug === '/') return null;
          try {
            const res = await fetch(`/api/panel/issues?repo=${encodeURIComponent(slug)}${fresh ? '&fresh=1' : ''}`);
            if (!res.ok) return null;
            const data = await res.json() as { issues?: Array<{ number: number; title: string; state: string; url?: string; labels?: Array<{ name: string } | string> }> };
            const openIssues = (data.issues ?? [])
              .filter((issue) => issue.state === 'open')
              .slice(0, 12)
              .map((issue) => ({
                number: issue.number,
                title: issue.title,
                url: issue.url,
                labels: (issue.labels ?? []).map((l) => typeof l === 'string' ? l : l.name),
              }));
            return { repoId: repo.id, repoName: repo.name, slug, issues: openIssues } as RepoIssuesGroup;
          } catch { return null; }
        }));

        if (!cancelled) {
          setIssueGroups(groups.filter((g): g is RepoIssuesGroup => g !== null && g.issues.length > 0));
        }
      } catch { /* silent */ }
      if (!cancelled) setIssuesLoading(false);
    };

    void fetchAllIssues(false);

    const handler = () => { void fetchAllIssues(true); };
    const wsEvents = ['o8:lane-lifecycle', 'o8:agent-lifecycle'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = setInterval(handler, 300_000);

    return () => { cancelled = true; clearInterval(fallbackId); for (const e of wsEvents) window.removeEventListener(e, handler); };
  }, [open, visible, workspaceTargets]);

  const updateMissionState = useCallback((
    updater: OrchestratorMissionState | ((current: OrchestratorMissionState) => OrchestratorMissionState),
  ) => {
    onMissionStateChange(updater);
  }, [onMissionStateChange]);

  const handleCreatePacketFromIssue = useCallback((issue: RepoIssue) => {
    const target = workspaceTargets[0] ?? null;
    updateMissionState((current) => ({
      ...current,
      packets: [
        ...current.packets,
        createDraftPacket(preferredRuntime, workspaceTargets, current.packets, {
          title: issue.title,
          summary: `#${issue.number} — ${issue.title}`,
          workspaceTargetPath: target?.localPath ?? null,
          queueState: 'draft',
        }),
      ],
    }));
  }, [preferredRuntime, updateMissionState, workspaceTargets]);

  const patchPacket = useCallback((packetId: string, updater: (packet: OrchestratorPacket) => OrchestratorPacket) => {
    updateMissionState((current) => ({
      ...current,
      packets: current.packets.map((packet) => (packet.id === packetId ? updater(packet) : packet)),
    }));
  }, [updateMissionState]);

  const updateReviewState = useCallback((packetId: string, updater: (current: ReviewPanelState) => ReviewPanelState) => {
    setReviewStateByPacketId((current) => {
      const existing = current[packetId] ?? {
        loaded: false,
        loading: false,
        laneId: null,
        worktreePath: null,
        repoPath: null,
        snapshot: null,
        error: null,
        action: null,
        actionError: null,
        actionNote: null,
        prUrl: null,
        showAllFiles: false,
      };
      return {
        ...current,
        [packetId]: updater(existing),
      };
    });
  }, []);

  const getBranchesForWorkspace = useCallback((workspaceTargetPath: string) => {
    const existingRequest = branchRequestByRepoPathRef.current[workspaceTargetPath];
    if (existingRequest) return existingRequest;
    const request = fetchPacketBranches(workspaceTargetPath)
      .finally(() => {
        delete branchRequestByRepoPathRef.current[workspaceTargetPath];
      });
    branchRequestByRepoPathRef.current[workspaceTargetPath] = request;
    return request;
  }, []);

  useEffect(() => {
    missionState.packets.forEach((packet) => {
      if (packet.queueState !== 'draft') return;
      if (!packet.workspaceTargetPath) return;
      if (hasPacketBranchTarget(packet.branchTarget)) return;

      const attemptKey = `${packet.id}:${packet.workspaceTargetPath}`;
      if (branchAutofillAttemptRef.current[packet.id] === attemptKey) return;
      branchAutofillAttemptRef.current[packet.id] = attemptKey;

      void getBranchesForWorkspace(packet.workspaceTargetPath)
        .then((branches) => {
          const currentBranch = findCurrentPacketBranch(branches);
          if (!currentBranch) return;
          patchPacket(packet.id, (current) => {
            if (current.workspaceTargetPath !== packet.workspaceTargetPath) return current;
            if (hasPacketBranchTarget(current.branchTarget)) return current;
            return {
              ...current,
              branchTarget: currentBranch.name,
              blockedReason: clearPacketBranchBlockedReason(current.blockedReason),
            };
          });
        })
        .catch(() => {});
    });
  }, [getBranchesForWorkspace, missionState.packets, patchPacket]);

  const handleLaunchPacket = useCallback(async (packet: OrchestratorPacket) => {
    if (!hasPacketBranchTarget(packet.branchTarget)) {
      patchPacket(packet.id, (current) => ({
        ...current,
        blockedReason: PACKET_BRANCH_REQUIRED_REASON,
      }));
      return;
    }
    try {
      const binding = await onLaunchPacket?.(packet);
      patchPacket(packet.id, (current) => ({
        ...current,
        queueState: 'queued',
        status: binding ? 'idle' : current.status,
        blockedReason: null,
        lane: binding ?? current.lane ?? null,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to launch this packet.';
      console.error(error);
      patchPacket(packet.id, (current) => ({
        ...current,
        blockedReason: message,
      }));
    }
  }, [onLaunchPacket, patchPacket]);

  const handleFocusPacket = useCallback((packet: OrchestratorPacket) => {
    onFocusPacket?.(packet);
  }, [onFocusPacket]);

  const handleReviewAction = useCallback(async (packet: OrchestratorPacket, verb: 'create_pr' | 'merge') => {
    const laneId = packet.lane?.laneId;
    if (!laneId) return;
    updateReviewState(packet.id, (current) => ({
      ...current,
      action: verb,
      actionError: null,
      actionNote: null,
      prUrl: verb === 'create_pr' ? current.prUrl : null,
    }));
    try {
      const response = await fetch('/api/lanes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          verb,
          laneId,
          commitMessage: verb === 'create_pr' ? 'Auto-commit from lane' : `Merge lane: ${packet.title}`,
        }),
      });
      const payload = await response.json().catch(() => null) as { ok?: boolean; note?: string } | null;
      const note = payload?.note ?? (verb === 'create_pr' ? 'Unable to create PR.' : 'Unable to merge this lane.');
      if (!response.ok || !payload?.ok) {
        throw new Error(verb === 'merge' && /conflict/i.test(note) ? `${note} Try "Create PR" instead.` : note);
      }
      const prUrlMatch = verb === 'create_pr' ? note.match(/https?:\/\/\S+/) : null;
      const prUrl = prUrlMatch?.[0]?.replace(/[)\].,]+$/, '') ?? null;
      updateReviewState(packet.id, (current) => ({
        ...current,
        action: null,
        actionError: null,
        actionNote: note,
        prUrl: prUrl ?? current.prUrl,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : verb === 'create_pr' ? 'Unable to create PR.' : 'Unable to merge this lane.';
      updateReviewState(packet.id, (current) => ({
        ...current,
        action: null,
        actionError: message,
      }));
    }
  }, [updateReviewState]);

  const handleResumePacket = useCallback((packet: OrchestratorPacket) => {
    fetch('/api/lanes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verb: 'resume', laneId: packet.lane?.laneId, message: 'Continue the previous task.', actor: 'user' }),
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!open || !visible || !expandedPacketId) return;

    const packet = missionState.packets.find((candidate) => candidate.id === expandedPacketId);
    if (!packet || packet.status !== 'awaiting_review' || !packet.lane?.laneId) return;

    const laneId = packet.lane.laneId;
    const currentReviewState = reviewStateByPacketId[packet.id];
    if (currentReviewState?.loading) return;
    if (currentReviewState?.loaded && currentReviewState.laneId === laneId) return;

    let cancelled = false;

    updateReviewState(packet.id, (current) => ({
      ...current,
      loading: true,
      loaded: false,
      laneId,
      error: null,
    }));

    (async () => {
      try {
        const laneRes = await fetch(`/api/lanes/${encodeURIComponent(laneId)}`);
        const laneData = await laneRes.json().catch(() => null) as { lane?: { worktreePath?: string | null; repoPath?: string | null }; note?: string } | null;
        if (!laneRes.ok) {
          throw new Error(laneData?.note ?? 'Unable to load lane details.');
        }

        const worktreePath = laneData?.lane?.worktreePath ?? null;
        const repoPath = packet.workspaceTargetPath ?? laneData?.lane?.repoPath ?? null;
        if (!worktreePath) {
          if (cancelled) return;
          updateReviewState(packet.id, (current) => ({
            ...current,
            loading: false,
            loaded: true,
            laneId,
            worktreePath: null,
            repoPath,
            snapshot: null,
            error: 'No worktree path for this lane yet.',
          }));
          return;
        }

        const reviewRes = await fetch('/api/review/snapshot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktreePath, repoPath }),
        });
        const reviewData = await reviewRes.json().catch(() => null) as {
          changedFiles?: Array<{ path: string; status: string; additions?: number | null; deletions?: number | null }>;
          diffStat?: string;
          warnings?: string[];
          recentCommits?: string[];
          note?: string;
        } | null;
        if (cancelled) return;
        if (!reviewRes.ok) {
          updateReviewState(packet.id, (current) => ({
            ...current,
            loading: false,
            loaded: true,
            laneId,
            worktreePath,
            repoPath,
            snapshot: null,
            error: reviewData?.note ?? 'Unable to load review snapshot.',
          }));
          return;
        }
        updateReviewState(packet.id, (current) => ({
          ...current,
          loading: false,
          loaded: true,
          laneId,
          worktreePath,
          repoPath,
          snapshot: {
            changedFiles: (reviewData?.changedFiles ?? []).map((file) => ({
              path: file.path,
              status: (file.status ?? 'modified') as 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked',
              additions: file.additions ?? null,
              deletions: file.deletions ?? null,
            })),
            diffStat: reviewData?.diffStat,
            warnings: reviewData?.warnings,
            recentCommits: reviewData?.recentCommits,
          },
          error: null,
        }));
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'Unable to load review snapshot.';
        updateReviewState(packet.id, (current) => ({
          ...current,
          loading: false,
          loaded: true,
          laneId,
          error: message,
        }));
      }
    })();

    return () => { cancelled = true; };
  }, [expandedPacketId, missionState.packets, open, reviewStateByPacketId, updateReviewState, visible]);

  return (
    <div className="thoughts-scroll" style={{
      flex: 1,
      overflowY: 'auto',
      paddingTop: 10,
      paddingRight: 10,
      paddingBottom: 10,
      paddingLeft: 10,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      background: thoughtsBodyBackground,
      minHeight: 0,
    }}>
      <IssueGroupList
        issueGroups={issueGroups}
        issueGroupCollapsed={issueGroupCollapsed}
        setIssueGroupCollapsed={setIssueGroupCollapsed}
        focusedRepoId={focusedRepoId}
        missionState={missionState}
        onCreatePacketFromIssue={handleCreatePacketFromIssue}
      />

      {/* Empty state — no issues and no packets */}
      {issueGroups.length === 0 && missionState.packets.length === 0 ? (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          paddingTop: 40,
          paddingBottom: 40,
          color: 'var(--t-text-muted)',
        }}>
          <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', opacity: 0.4 }}>
            <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
            <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
          </svg>
          <span style={{ fontSize: 11, fontWeight: 500 }}>
            {issuesLoading ? 'Loading issues...' : 'No open issues or packets'}
          </span>
          <span style={{ fontSize: 10, color: 'var(--t-text-faint)', textAlign: 'center', maxWidth: 200 }}>
            Issues from GitHub and dispatch packets will appear here.
          </span>
        </div>
      ) : null}

      {missionState.packets.map((packet) => {
        const isExpanded = expandedPacketId === packet.id;
        const reviewState = reviewStateByPacketId[packet.id] ?? null;
        return (
          <PacketCard
            key={packet.id}
            packet={packet}
            allPackets={missionState.packets}
            isExpanded={isExpanded}
            onToggleExpanded={() => setExpandedPacketId(isExpanded ? null : packet.id)}
            editingField={editingField}
            onEditingFieldChange={setEditingField}
            workspaceTargets={workspaceTargets}
            reviewState={reviewState}
            onPatch={(updater) => patchPacket(packet.id, updater)}
            onLaunch={() => { void handleLaunchPacket(packet); }}
            onFocus={() => handleFocusPacket(packet)}
            onDelete={() => {
              updateMissionState((current) => ({
                ...current,
                packets: current.packets.filter((p) => p.id !== packet.id),
              }));
            }}
            onReviewAction={(verb) => { void handleReviewAction(packet, verb); }}
            onToggleShowAllFiles={() => updateReviewState(packet.id, (current) => ({ ...current, showAllFiles: !current.showAllFiles }))}
            onResume={() => handleResumePacket(packet)}
          />
        );
      })}
    </div>
  );
}
