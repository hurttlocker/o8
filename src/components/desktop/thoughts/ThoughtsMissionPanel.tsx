'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  OrchestratorLaneBinding,
  OrchestratorMissionState,
  OrchestratorPacket,
  OrchestratorRuntime,
  OrchestratorWorkspaceTarget,
} from '@/lib/orchestrator/types';
import type { AgentTarget } from './types';
import { createDraftPacket } from './utils';
import { ComparisonCard } from './ComparisonCard';
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
import { StatusGroupedLanes } from './mission-panel/StatusGroupedLanes';
import type { DirectiveProposalCandidate } from './directive-proposal-types';
import { useDirectiveProposals } from './mission-panel/useDirectiveProposals';
import { DirectiveProposalSection } from './mission-panel/DirectiveProposalSection';
import { useOrchestratorData } from '../orchestrator-data-context';

// #517 — Rough per-run cost estimate used only for the fan-out gate warning.
// Not meant to be accurate — it just reminds the operator that running 3+
// frontier models in parallel is expensive.
const COMPARISON_COST_ESTIMATE_PER_MODEL_USD = 0.60;
const COMPARISON_FAN_OUT_WARN_THRESHOLD = 2;

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
  // #634 — surface fetch errors instead of silently flipping loading off and
  // rendering an empty state that the operator can't distinguish from "no
  // open issues". Tracked separately from issuesLoading so a stale error can
  // remain visible while a retry attempt is in flight.
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [issuesRetryNonce, setIssuesRetryNonce] = useState(0);
  // #626 — cache of workspace localPath → GitHub remoteUrl, reused by PacketCard
  // so its "open" action can derive an issue URL when packet.issue?.url is absent.
  const [repoRemoteUrlByPath, setRepoRemoteUrlByPath] = useState<Record<string, string | null>>({});
  const [expandedPacketId, setExpandedPacketId] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<EditingField>(null);
  const [reviewStateByPacketId, setReviewStateByPacketId] = useState<Record<string, ReviewPanelState>>({});
  const branchAutofillAttemptRef = useRef<Record<string, string>>({});
  const branchRequestByRepoPathRef = useRef<Record<string, Promise<Awaited<ReturnType<typeof fetchPacketBranches>>>>>({});
  const orchestratorData = useOrchestratorData();

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
        if (cancelled) { setIssuesLoading(false); return; }
        if (!reposRes.ok) {
          // #634 — repos endpoint failed. The whole panel depends on it so
          // surface a single error rather than silently rendering empty.
          console.warn(`[error-state] /api/panel/repos returned ${reposRes.status}`);
          setIssuesError(`Couldn't load repos (HTTP ${reposRes.status}).`);
          setIssuesLoading(false);
          return;
        }
        const reposData = await reposRes.json() as { repos?: Array<{ id: string; name: string; localPath: string; remoteUrl?: string }> };
        const repos = reposData.repos ?? [];

        if (!cancelled) {
          // #626 — snapshot the localPath → remoteUrl mapping for PacketCard.
          const nextMap: Record<string, string | null> = {};
          for (const repo of repos) {
            if (repo.localPath) nextMap[repo.localPath] = repo.remoteUrl ?? null;
          }
          setRepoRemoteUrlByPath(nextMap);
        }

        // #634 — track per-repo issue-fetch failures. We keep partial results
        // (some repos load, others fail) but tell the operator which slugs
        // didn't make it so they don't think GitHub has nothing for them.
        let issueFetchFailures = 0;
        const groups = await Promise.all(repos.map(async (repo) => {
          if (!repo.remoteUrl) return null;
          const slug = repo.remoteUrl.replace(/\.git$/, '').split('/').slice(-2).join('/');
          if (!slug || slug === '/') return null;
          try {
            const res = await fetch(`/api/panel/issues?repo=${encodeURIComponent(slug)}${fresh ? '&fresh=1' : ''}`);
            if (!res.ok) {
              console.warn(`[error-state] /api/panel/issues?repo=${slug} returned ${res.status}`);
              issueFetchFailures += 1;
              return null;
            }
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
          } catch (issueErr) {
            console.warn(`[error-state] issue fetch threw for repo=${slug}:`, issueErr);
            issueFetchFailures += 1;
            return null;
          }
        }));

        if (!cancelled) {
          setIssueGroups(groups.filter((g): g is RepoIssuesGroup => g !== null && g.issues.length > 0));
          if (issueFetchFailures > 0 && repos.length > 0) {
            const repoWord = issueFetchFailures === 1 ? 'repo' : 'repos';
            setIssuesError(`Couldn't load issues for ${issueFetchFailures} ${repoWord}.`);
          } else {
            setIssuesError(null);
          }
        }
      } catch (err) {
        // #634 — top-level network failure (offline, fetch threw, etc).
        console.warn('[error-state] ThoughtsMissionPanel issue load failed:', err);
        if (!cancelled) setIssuesError("Couldn't reach the local API. Backend may be offline.");
      }
      if (!cancelled) setIssuesLoading(false);
    };

    void fetchAllIssues(false);

    const handler = () => { void fetchAllIssues(true); };
    const wsEvents = ['o8:lane-lifecycle', 'o8:agent-lifecycle'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = setInterval(handler, 300_000);

    return () => { cancelled = true; clearInterval(fallbackId); for (const e of wsEvents) window.removeEventListener(e, handler); };
  }, [open, visible, workspaceTargets, issuesRetryNonce]);

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

  // #746 — Auto-directive proposer rows. State + fetch + dismiss live in
  // the dedicated hook; the panel just maps Accept onto the orchestrator
  // data context's `onAcceptDirectiveProposal` callback.
  const handleAcceptProposalDraft = useCallback((proposal: DirectiveProposalCandidate) => {
    // Pre-fill the orchestrator chat composer via the shared draft injection
    // hook. The operator edits + sends; orchestrator-side memory tools then
    // write the directive markdown. We never write the file ourselves —
    // human-gated by design.
    const draftText = [
      'Please save the following directive after I review it:',
      '',
      proposal.draftDirective,
    ].join('\n');
    orchestratorData?.onAcceptDirectiveProposal?.({
      id: `proposal-accept-${proposal.id}-${Date.now()}`,
      text: draftText,
    });
  }, [orchestratorData]);

  const {
    proposals,
    pendingProposalId,
    handleAccept: handleAcceptProposal,
    handleDismiss: handleDismissProposal,
  } = useDirectiveProposals({
    open,
    visible,
    retryNonce: issuesRetryNonce,
    onAccept: handleAcceptProposalDraft,
  });

  // #517 — Best-of-n: bucket packets by comparisonGroupId so each group
  // renders ONCE via ComparisonCard instead of N separate PacketCards.
  const comparisonGroups = useMemo(() => {
    const groups = new Map<string, OrchestratorPacket[]>();
    for (const packet of missionState.packets) {
      if (!packet.comparisonGroupId) continue;
      const current = groups.get(packet.comparisonGroupId) ?? [];
      current.push(packet);
      groups.set(packet.comparisonGroupId, current);
    }
    return groups;
  }, [missionState.packets]);

  // #517 — Cost warning: any draft packet staged with fan-out > 2 gets a
  // non-blocking callout. Once the packet is dispatched it sheds
  // `comparisonModels` (scheduling.ts clears it after fan-out) so the
  // warning auto-dismisses.
  const pendingFanOutCost = useMemo(() => {
    let worstCount = 0;
    for (const packet of missionState.packets) {
      const count = packet.comparisonModels?.length ?? 0;
      if (count > worstCount) worstCount = count;
    }
    if (worstCount <= COMPARISON_FAN_OUT_WARN_THRESHOLD) return null;
    return {
      fanOut: worstCount,
      estimateUsd: Math.round(worstCount * COMPARISON_COST_ESTIMATE_PER_MODEL_USD * 100) / 100,
    };
  }, [missionState.packets]);

  const handlePickComparisonWinner = useCallback(async (packetId: string) => {
    try {
      const response = await fetch('/api/orchestrator/comparison-pick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packetId }),
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error?.message ?? 'Unable to pick the comparison winner.');
      }
    } catch (error) {
      console.error('[best-of-n] Failed to pick comparison winner.', error);
    }
  }, []);

  // #517 — Tracked outside the renderPacket closure so the dedupe set is
  // shared across all section traversals in StatusGroupedLanes. Recreated
  // every parent render so it resets cleanly between re-renders. Plain
  // const (not useCallback) so the Set never gets stale between renders.
  const renderedComparisonGroupIds = new Set<string>();

  const renderPacket = (packet: OrchestratorPacket) => {
    // Comparison-group siblings: render ONE ComparisonCard at the first
    // sibling's position, return null for the rest.
    if (packet.comparisonGroupId) {
      if (renderedComparisonGroupIds.has(packet.comparisonGroupId)) {
        return null;
      }
      renderedComparisonGroupIds.add(packet.comparisonGroupId);
      const groupPackets = comparisonGroups.get(packet.comparisonGroupId) ?? [packet];
      return (
        <ComparisonCard
          key={`cmp-${packet.comparisonGroupId}`}
          groupId={packet.comparisonGroupId}
          packets={groupPackets}
          onPickWinner={handlePickComparisonWinner}
        />
      );
    }

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
        repoRemoteUrlByPath={repoRemoteUrlByPath}
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
  };

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
      {/* #634 — surface fetch errors instead of an indistinguishable empty
          state. The block is small and inline so it doesn't cover the whole
          panel; partial results above still render. */}
      {issuesError ? (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            paddingTop: 8,
            paddingRight: 10,
            paddingBottom: 8,
            paddingLeft: 10,
            borderRadius: 10,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'rgba(239, 68, 68, 0.28)',
            background: 'rgba(239, 68, 68, 0.06)',
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
          }}
        >
          <svg
            width={14}
            height={14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="#dc2626"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0, marginTop: 1 }}
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: '#b91c1c', letterSpacing: '-0.01em' }}>
              Couldn&apos;t load issues
            </div>
            <div style={{ fontSize: 10, color: 'var(--t-text-secondary)', marginTop: 2, lineHeight: 1.4 }}>
              {issuesError}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIssuesRetryNonce((n) => n + 1)}
            disabled={issuesLoading}
            style={{
              flexShrink: 0,
              paddingTop: 3,
              paddingRight: 8,
              paddingBottom: 3,
              paddingLeft: 8,
              borderRadius: 6,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'rgba(239, 68, 68, 0.28)',
              background: issuesLoading ? 'rgba(239, 68, 68, 0.04)' : 'rgba(239, 68, 68, 0.10)',
              color: '#b91c1c',
              fontSize: 10,
              fontWeight: 700,
              cursor: issuesLoading ? 'wait' : 'pointer',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            }}
          >
            {issuesLoading ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      ) : null}

      {/* #746 — Auto-directive proposer rows. Anchored above Open Issues
          because they're "advice the system gives the operator" — should
          read like a recommendation, not a queued task. */}
      <DirectiveProposalSection
        proposals={proposals}
        pendingProposalId={pendingProposalId}
        onAccept={handleAcceptProposal}
        onDismiss={handleDismissProposal}
      />

      <IssueGroupList
        issueGroups={issueGroups}
        issueGroupCollapsed={issueGroupCollapsed}
        setIssueGroupCollapsed={setIssueGroupCollapsed}
        focusedRepoId={focusedRepoId}
        missionState={missionState}
        onCreatePacketFromIssue={handleCreatePacketFromIssue}
      />

      {pendingFanOutCost ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            paddingTop: 8,
            paddingRight: 10,
            paddingBottom: 8,
            paddingLeft: 10,
            borderRadius: 10,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'rgba(245, 158, 11, 0.32)',
            background: 'rgba(245, 158, 11, 0.08)',
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#b45309" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </svg>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: '#b45309', letterSpacing: '-0.01em' }}>
              Fan-out of {pendingFanOutCost.fanOut} models
            </div>
            <div style={{ fontSize: 10, color: 'var(--t-text-secondary)', marginTop: 2, lineHeight: 1.4 }}>
              Runs all {pendingFanOutCost.fanOut} models in parallel worktrees. Rough estimate ~${pendingFanOutCost.estimateUsd.toFixed(2)} per packet. Trim the comparison list if this is a routine change.
            </div>
          </div>
        </div>
      ) : null}

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

      {/* #772 — Status-grouped sectioned list. Empty groups collapse, so
          the operator never sees `DONE · 0` headers. Each section's
          open/closed state persists per-status to localStorage. */}
      <StatusGroupedLanes packets={missionState.packets} renderPacket={renderPacket} />
    </div>
  );
}
