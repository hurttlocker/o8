'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { MissionCostSummary } from '@/lib/orchestrator/cost-aggregator';
import {
  orchestratorRuntimeTone,
  orchestratorStatusTone,
} from '@/lib/orchestrator/display';
import { packetReleaseBlockedBy } from '@/lib/orchestrator/store';
import type {
  OrchestratorLaneBinding,
  OrchestratorMissionState,
  OrchestratorPacket,
  OrchestratorRuntime,
  OrchestratorWorkspaceTarget,
} from '@/lib/orchestrator/types';
import type { AgentTarget } from './types';
import {
  buildPacketsFromMissionPrompt,
  createDraftPacket,
  packetTitleFromPrompt,
  summarizeMissionPrompt,
} from './utils';

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function hasMissionCostTelemetry(summary: MissionCostSummary | null) {
  return (summary?.packetCosts ?? []).some((packetCost) => packetCost.hasTelemetry);
}

function formatCostLabel(totalCostUsd: number, hasTelemetry: boolean) {
  if (!hasTelemetry) {
    return 'No data';
  }
  if (totalCostUsd < 0.005) {
    return '~$0.00';
  }
  return usdFormatter.format(totalCostUsd);
}

function costTone(totalCostUsd: number, hasTelemetry: boolean) {
  if (!hasTelemetry) {
    return {
      color: 'var(--t-text-muted)',
      background: 'rgba(148, 163, 184, 0.12)',
      border: 'rgba(148, 163, 184, 0.18)',
    };
  }

  if (totalCostUsd > 5) {
    return {
      color: '#ef4444',
      background: 'rgba(239, 68, 68, 0.1)',
      border: 'rgba(239, 68, 68, 0.18)',
    };
  }

  if (totalCostUsd >= 1) {
    return {
      color: '#f59e0b',
      background: 'rgba(245, 158, 11, 0.12)',
      border: 'rgba(245, 158, 11, 0.2)',
    };
  }

  return {
    color: '#16a34a',
    background: 'rgba(34, 197, 94, 0.1)',
    border: 'rgba(34, 197, 94, 0.16)',
  };
}

export interface ThoughtsMissionPanelHandle {
  focusInput: () => void;
}

export const ThoughtsMissionPanel = forwardRef<ThoughtsMissionPanelHandle, {
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
}>(function ThoughtsMissionPanel({
  open,
  visible,
  missionState,
  workspaceTargets,
  preferredRuntime,
  sessionTargets,
  thoughtsBodyBackground,
  thoughtsElevatedSurface,
  thoughtsElevatedBorder,
  thoughtsElevatedShadow,
  thoughtsMutedGlass,
  onMissionStateChange,
  onLaunchPacket,
  onFocusPacket,
}, ref) {
  type RepoIssue = { number: number; title: string; url?: string; labels?: string[] };
  type ReviewChangedFile = {
    path: string;
    status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
    additions?: number | null;
    deletions?: number | null;
  };
  type ReviewSnapshot = {
    changedFiles?: ReviewChangedFile[];
    diffStat?: string;
    warnings?: string[];
    recentCommits?: string[];
    error?: string;
  };
  type ReviewPanelState = {
    loaded: boolean;
    loading: boolean;
    laneId: string | null;
    worktreePath: string | null;
    repoPath: string | null;
    snapshot: ReviewSnapshot | null;
    error: string | null;
    action: 'create_pr' | 'merge' | null;
    actionError: string | null;
    actionNote: string | null;
    prUrl: string | null;
    showAllFiles: boolean;
  };

  const [repoIssues, setRepoIssues] = useState<RepoIssue[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesCollapsed, setIssuesCollapsed] = useState(false);
  const [issuesShowAll, setIssuesShowAll] = useState(false);
  const [expandedPacketId, setExpandedPacketId] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<{ packetId: string; field: 'summary' | 'runtime' | 'repo' | 'branch' } | null>(null);
  const [missionCostSummary, setMissionCostSummary] = useState<MissionCostSummary | null>(null);
  const [reviewStateByPacketId, setReviewStateByPacketId] = useState<Record<string, ReviewPanelState>>({});
  const issuesRepoSlugRef = useRef<string | null>(null);
  const missionPromptRef = useRef<HTMLTextAreaElement>(null);
  const missionStateRef = useRef(missionState);

  void issuesLoading;

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

  const missionCostRefreshKey = useMemo(() => missionState.packets.map((packet) => [
    packet.id,
    packet.runtime,
    packet.status,
    packet.lane?.runtime ?? '',
    packet.lane?.sessionKey ?? '',
    packet.lane?.laneId ?? '',
  ].join(':')).join('|'), [missionState.packets]);
  const packetCostById = useMemo(
    () => new Map((missionCostSummary?.packetCosts ?? []).map((packetCost) => [packetCost.packetId, packetCost] as const)),
    [missionCostSummary],
  );
  const missionHasCostData = hasMissionCostTelemetry(missionCostSummary);
  const missionCostBadgeTone = costTone(missionCostSummary?.totalCostUsd ?? 0, missionHasCostData);
  const missionCostLabel = formatCostLabel(missionCostSummary?.totalCostUsd ?? 0, missionHasCostData);

  useEffect(() => {
    if (!open || !visible || workspaceTargets.length === 0) return;

    let cancelled = false;
    let resolvedSlug: string | null = null;

    const fetchIssues = async (fresh: boolean) => {
      try {
        if (!resolvedSlug) {
          const reposRes = await fetch('/api/panel/repos');
          if (!reposRes.ok || cancelled) return;
          const reposData = await reposRes.json() as { repos?: Array<{ localPath: string; remoteUrl?: string }> };
          const targetPath = workspaceTargets[0]?.localPath;
          const matched = (reposData.repos ?? []).find((repo) => repo.localPath === targetPath);
          if (!matched?.remoteUrl || cancelled) return;
          resolvedSlug = matched.remoteUrl.replace(/\.git$/, '').split('/').slice(-2).join('/');
        }
        if (!resolvedSlug) return;
        issuesRepoSlugRef.current = resolvedSlug;

        setIssuesLoading(true);
        const issuesRes = await fetch(`/api/panel/issues?repo=${encodeURIComponent(resolvedSlug)}${fresh ? '&fresh=1' : ''}`);
        if (!issuesRes.ok || cancelled) { setIssuesLoading(false); return; }
        const issuesData = await issuesRes.json() as { issues?: Array<{ number: number; title: string; state: string; url?: string; labels?: Array<{ name: string } | string> }> };
        const openIssues = (issuesData.issues ?? [])
          .filter((issue) => issue.state === 'open')
          .slice(0, 12)
          .map((issue) => ({
            number: issue.number,
            title: issue.title,
            url: issue.url,
            labels: (issue.labels ?? []).map((label) => typeof label === 'string' ? label : label.name),
          }));
        if (!cancelled) setRepoIssues(openIssues);
      } catch {
        // silent
      }
      if (!cancelled) setIssuesLoading(false);
    };

    // Initial fetch
    void fetchIssues(false);

    // WS-driven: instant refresh on lane events instead of 30s polling
    const handler = () => { void fetchIssues(true); };
    const wsEvents = ['o8:lane-lifecycle', 'o8:agent-lifecycle'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = setInterval(handler, 300_000);

    return () => { cancelled = true; clearInterval(fallbackId); for (const e of wsEvents) window.removeEventListener(e, handler); };
  }, [open, visible, workspaceTargets]);

  useEffect(() => {
    missionStateRef.current = missionState;
  }, [missionState]);

  useEffect(() => {
    if (!open || !visible || missionState.packets.length === 0) {
      setMissionCostSummary(null);
      return;
    }

    let cancelled = false;
    let currentController: AbortController | null = null;

    const fetchMissionCost = async () => {
      currentController?.abort();
      const nextController = new AbortController();
      currentController = nextController;

      try {
        const response = await fetch('/api/orchestrator/cost', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mission: missionStateRef.current }),
          signal: nextController.signal,
        });
        const payload = await response.json().catch(() => null) as { cost?: MissionCostSummary; error?: string } | null;
        if (!response.ok) {
          throw new Error(payload?.error ?? 'Unable to load mission cost.');
        }
        if (!cancelled) {
          setMissionCostSummary(payload?.cost ?? null);
        }
      } catch (error) {
        if (nextController.signal.aborted || cancelled) {
          return;
        }
        console.error('[cost-agg] Failed to load mission cost.', error);
        if (!cancelled) {
          setMissionCostSummary(null);
        }
      }
    };

    void fetchMissionCost();
    // WS-driven: refresh cost on lane events instead of 30s polling
    const handler = () => { void fetchMissionCost(); };
    const wsEvents = ['o8:lane-lifecycle'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = window.setInterval(handler, 300_000);

    return () => {
      cancelled = true;
      currentController?.abort();
      window.clearInterval(fallbackId);
      for (const e of wsEvents) window.removeEventListener(e, handler);
    };
  }, [missionCostRefreshKey, missionState.packets.length, open, visible]);

  const updateMissionState = useCallback((
    updater: OrchestratorMissionState | ((current: OrchestratorMissionState) => OrchestratorMissionState),
  ) => {
    onMissionStateChange(updater);
  }, [onMissionStateChange]);

  const handleMissionPromptChange = useCallback((value: string) => {
    updateMissionState((current) => ({
      ...current,
      prompt: value,
    }));
  }, [updateMissionState]);

  const handlePlanMission = useCallback(() => {
    const normalizedPrompt = missionState.prompt.trim();
    if (!normalizedPrompt) return;
    const plannedPackets = buildPacketsFromMissionPrompt(normalizedPrompt, workspaceTargets, preferredRuntime);
    updateMissionState((current) => ({
      ...current,
      prompt: missionState.prompt,
      summary: summarizeMissionPrompt(normalizedPrompt),
      packets: plannedPackets.length > 0
        ? plannedPackets
        : [createDraftPacket(preferredRuntime, workspaceTargets, [], {
            title: packetTitleFromPrompt(normalizedPrompt),
            summary: normalizedPrompt,
          })],
    }));
  }, [missionState.prompt, preferredRuntime, updateMissionState, workspaceTargets]);

  const handleAddPacket = useCallback(() => {
    updateMissionState((current) => ({
      ...current,
      packets: [
        ...current.packets,
        createDraftPacket(preferredRuntime, workspaceTargets, current.packets),
      ],
    }));
  }, [preferredRuntime, updateMissionState, workspaceTargets]);

  const handleCreatePacketFromIssue = useCallback((issue: { number: number; title: string }) => {
    const target = workspaceTargets[0] ?? null;
    updateMissionState((current) => ({
      ...current,
      packets: [
        ...current.packets,
        createDraftPacket(preferredRuntime, workspaceTargets, current.packets, {
          title: issue.title,
          summary: `#${issue.number} — ${issue.title}`,
          workspaceTargetPath: target?.localPath ?? null,
          branchTarget: target?.branch ?? 'main',
          queueState: 'draft',
        }),
      ],
    }));
  }, [preferredRuntime, updateMissionState, workspaceTargets]);

  const handleRemovePacketForIssue = useCallback((issueNumber: number) => {
    updateMissionState((current) => ({
      ...current,
      packets: current.packets.filter((packet) => !packet.summary.includes(`#${issueNumber}`)),
    }));
  }, [updateMissionState]);

  const handleLinkIssueToPacket = useCallback((issue: { number: number; title: string }) => {
    const targetId = expandedPacketId ?? missionState.packets[missionState.packets.length - 1]?.id;
    if (!targetId) return;
    updateMissionState((current) => ({
      ...current,
      packets: current.packets.map((packet) => {
        if (packet.id !== targetId) return packet;
        const ref = `#${issue.number}`;
        if (packet.summary.includes(ref)) return packet;
        const nextSummary = packet.summary ? `${packet.summary}\n${ref} — ${issue.title}` : `${ref} — ${issue.title}`;
        return { ...packet, summary: nextSummary };
      }),
    }));
  }, [expandedPacketId, missionState.packets, updateMissionState]);

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

  const handleLaunchPacket = useCallback(async (packet: OrchestratorPacket) => {
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
            worktreePath,
            repoPath,
            snapshot: null,
            error: 'No worktree is attached to this lane yet.',
          }));
          return;
        }

        const searchParams = new URLSearchParams({ workspace: worktreePath });
        if (repoPath && !repoPath.startsWith('/') && repoPath.includes('/')) {
          searchParams.set('repo', repoPath);
        }
        const reviewRes = await fetch(`/api/review/workspace?${searchParams.toString()}`);
        const reviewData = await reviewRes.json().catch(() => null) as ReviewSnapshot | null;
        if (!reviewRes.ok) {
          throw new Error(reviewData?.error ?? 'Unable to load review snapshot.');
        }
        if (cancelled) return;
        updateReviewState(packet.id, (current) => ({
          ...current,
          loading: false,
          loaded: true,
          laneId,
          worktreePath,
          repoPath,
          snapshot: reviewData,
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

  useImperativeHandle(ref, () => ({
    focusInput() {
      missionPromptRef.current?.focus();
    },
  }), []);

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
      {/* Mission Control header + packet input removed — packets are now
          created exclusively through the orchestrator chat or MCP tools.
          The Issues list below is the only user-facing surface here. */}

      {false && <div style={{
        paddingTop: 12,
        paddingRight: 14,
        paddingBottom: 12,
        paddingLeft: 14,
        borderRadius: 12,
        background: thoughtsElevatedSurface,
        border: thoughtsElevatedBorder,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.01em', marginRight: 'auto' }}>
            Mission Control
          </div>
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            paddingTop: 2,
            paddingRight: 7,
            paddingBottom: 2,
            paddingLeft: 7,
            borderRadius: 999,
            background: thoughtsMutedGlass,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider-subtle)',
            fontSize: 9,
            fontWeight: 700,
            color: orchestratorRuntimeTone(preferredRuntime).color,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}>
            {orchestratorRuntimeTone(preferredRuntime).label}
          </span>
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            paddingTop: 2,
            paddingRight: 7,
            paddingBottom: 2,
            paddingLeft: 7,
            borderRadius: 999,
            background: thoughtsMutedGlass,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider-subtle)',
            fontSize: 9,
            fontWeight: 700,
            color: 'var(--t-text-muted)',
          }}>
            {sessionTargets.length} lane{sessionTargets.length === 1 ? '' : 's'}
          </span>
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            paddingTop: 2,
            paddingRight: 7,
            paddingBottom: 2,
            paddingLeft: 7,
            borderRadius: 999,
            background: missionCostBadgeTone.background,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: missionCostBadgeTone.border,
            fontSize: 9,
            fontWeight: 700,
            color: missionCostBadgeTone.color,
          }}>
            {missionCostLabel}
          </span>
          <button
            type="button"
            onClick={handleAddPacket}
            title="Add empty packet"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 20,
              height: 20,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-divider-subtle)',
              borderRadius: 5,
              background: 'transparent',
              color: 'var(--t-text-muted)',
              cursor: 'pointer',
              fontSize: 13,
              lineHeight: 1,
              padding: 0,
              marginLeft: 2,
              transition: 'background 120ms ease, color 120ms ease, border-color 120ms ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--t-accent-soft)';
              e.currentTarget.style.color = 'var(--t-accent)';
              e.currentTarget.style.borderColor = 'var(--t-accent-border)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--t-text-muted)';
              e.currentTarget.style.borderColor = 'var(--t-divider-subtle)';
            }}
          >
            +
          </button>
        </div>

        {/* Input block — framed input with Plan Packets as an inline
            bottom-right action, like a chat composer. Gives the textarea
            more breathing room and anchors the primary action to the
            same visual block. */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 10,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-input-border)',
            background: 'var(--t-input-bg)',
            overflow: 'hidden',
            transition: 'border-color 150ms ease, box-shadow 150ms ease',
          }}
          onFocus={(event) => {
            event.currentTarget.style.borderColor = 'var(--t-accent-border)';
            event.currentTarget.style.boxShadow = '0 0 0 3px var(--t-accent-ring)';
          }}
          onBlur={(event) => {
            event.currentTarget.style.borderColor = 'var(--t-input-border)';
            event.currentTarget.style.boxShadow = 'none';
          }}
        >
          <textarea
            ref={missionPromptRef}
            value={missionState.prompt}
            onChange={(event) => handleMissionPromptChange(event.target.value)}
            placeholder="Describe the mission…"
            style={{
              width: '100%',
              minHeight: 72,
              paddingTop: 12,
              paddingRight: 14,
              paddingBottom: 8,
              paddingLeft: 14,
              borderWidth: 0,
              background: 'transparent',
              fontSize: 12,
              color: 'var(--t-text)',
              resize: 'none',
              outline: 'none',
              fontFamily: 'inherit',
              lineHeight: 1.5,
              boxSizing: 'border-box',
            }}
          />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 6,
              paddingTop: 6,
              paddingRight: 8,
              paddingBottom: 8,
              paddingLeft: 14,
            }}
          >
            <span
              style={{
                fontSize: 9,
                fontWeight: 600,
                color: 'var(--t-text-faint)',
                marginRight: 'auto',
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
              }}
            >
              {missionState.prompt.trim().length > 0
                ? `${missionState.prompt.trim().length} chars`
                : 'Empty'}
            </span>
            <button
              type="button"
              onClick={handlePlanMission}
              disabled={!missionState.prompt.trim()}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                borderWidth: 0,
                background: missionState.prompt.trim() ? '#2563eb' : 'var(--t-divider)',
                color: missionState.prompt.trim() ? '#fff' : 'var(--t-text-faint)',
                paddingTop: 6,
                paddingRight: 12,
                paddingBottom: 6,
                paddingLeft: 12,
                borderRadius: 7,
                fontSize: 11,
                fontWeight: 700,
                cursor: missionState.prompt.trim() ? 'pointer' : 'default',
                letterSpacing: '-0.01em',
                transition: 'background 120ms ease',
              }}
            >
              Plan Packets
              <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>}

      {repoIssues.length > 0 ? (
        <div style={{
          paddingTop: 9,
          paddingRight: 12,
          paddingBottom: 9,
          paddingLeft: 12,
          borderRadius: 10,
          background: 'var(--t-panel)',
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-panel-border)',
        }}>
          <button
            type="button"
            onClick={() => setIssuesCollapsed((value) => !value)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
              border: 'none',
              background: 'transparent',
              padding: 0,
              cursor: 'pointer',
              marginBottom: issuesCollapsed ? 0 : 10,
            }}
          >
            <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--t-text-muted)' }}>
              Open Issues
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                padding: '2px 7px',
                borderRadius: 999,
                background: 'var(--t-divider-subtle)',
                color: 'var(--t-text-secondary)',
                fontSize: 10,
                fontWeight: 700,
              }}>
                {repoIssues.length}
              </span>
              <svg width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="var(--t-text-muted)" strokeWidth="1.5" strokeLinecap="round" style={{ transform: issuesCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 150ms ease' }}>
                <path d="M2.5 3.5L5 6L7.5 3.5" />
              </svg>
            </div>
          </button>
          {!issuesCollapsed ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {(issuesShowAll ? repoIssues : repoIssues.slice(0, 5)).map((issue) => {
                const alreadyPacketed = missionState.packets.some(
                  (packet) => packet.summary.includes(`#${issue.number}`) || packet.title === issue.title,
                );
                return (
                  <div
                    key={issue.number}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '6px 8px',
                      borderRadius: 10,
                      transition: 'background 120ms ease',
                    }}
                    onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-divider-subtle)'; }}
                    onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t-text-muted)', fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)', minWidth: 36, flexShrink: 0 }}>
                      #{issue.number}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--t-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {issue.title}
                    </span>
                    {alreadyPacketed ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                        <button type="button" onClick={() => handleLinkIssueToPacket(issue)} title="Link to current packet"
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '2px 4px', display: 'flex', alignItems: 'center' }}>
                          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--t-text-muted)" strokeWidth="2" strokeLinecap="round" style={{ opacity: 0.5 }}>
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                          </svg>
                        </button>
                        <button type="button" onClick={() => handleRemovePacketForIssue(issue.number)} title="Remove packet"
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '2px 4px', display: 'flex', alignItems: 'center' }}>
                          <span style={{ fontSize: 14, color: 'var(--t-text-muted)', opacity: 0.5, lineHeight: 1 }}>-</span>
                        </button>
                      </div>
                    ) : (
                      <button type="button" onClick={() => handleCreatePacketFromIssue(issue)} title="Create work packet"
                        style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '2px 4px', flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                        <span style={{ fontSize: 14, color: 'var(--t-text-muted)', opacity: 0.5, lineHeight: 1 }}>+</span>
                      </button>
                    )}
                  </div>
                );
              })}
              {repoIssues.length > 5 ? (
                <button
                  type="button"
                  onClick={() => setIssuesShowAll((value) => !value)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--t-text-muted)',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                    padding: '6px 8px',
                    textAlign: 'left',
                  }}
                >
                  {issuesShowAll ? 'Show less' : `Show all ${repoIssues.length} issues`}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {missionState.packets.map((packet) => {
        const statusMeta = orchestratorStatusTone(packet.status);
        const runtimeMeta = orchestratorRuntimeTone(packet.runtime);
        const dependencyBlocker = packetReleaseBlockedBy(packet, missionState.packets);
        const canLaunch = !packet.archivedAt && packet.releaseState !== 'released' && packet.queueState !== 'held' && !dependencyBlocker;
        const hasInteractiveLane = Boolean(packet.lane?.tileId && packet.lane?.tabId);
        const isExpanded = expandedPacketId === packet.id;
        const targetLabel = workspaceTargets.find((target) => target.localPath === packet.workspaceTargetPath)?.label ?? null;
        const reviewState = reviewStateByPacketId[packet.id] ?? null;
        const reviewFiles = reviewState?.snapshot?.changedFiles ?? [];
        const reviewWarnings = reviewState?.snapshot?.warnings ?? [];
        const reviewFileCount = reviewFiles.length;
        const reviewAdditions = reviewFiles.reduce((sum, file) => sum + Math.max(0, file.additions ?? 0), 0);
        const reviewDeletions = reviewFiles.reduce((sum, file) => sum + Math.max(0, file.deletions ?? 0), 0);
        const visibleReviewFiles = reviewState?.showAllFiles ? reviewFiles : reviewFiles.slice(0, 5);
        const showReviewSection = packet.status === 'awaiting_review' && Boolean(packet.lane?.laneId);
        const reviewWarningText = reviewWarnings.length > 0 ? reviewWarnings.slice(0, 2).join(' ') : null;
        const packetCost = packetCostById.get(packet.id) ?? null;
        const packetHasCostData = Boolean(packetCost?.hasTelemetry);
        const packetCostBadgeTone = costTone(packetCost?.totalCostUsd ?? 0, packetHasCostData);
        const packetCostLabel = formatCostLabel(packetCost?.totalCostUsd ?? 0, packetHasCostData);

        return (
          <div
            key={packet.id}
            style={{
              borderRadius: 10,
              background: 'var(--t-panel)',
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-panel-border)',
              flexShrink: 0,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                width: '100%',
                paddingTop: 6,
                paddingRight: 10,
                paddingBottom: 6,
                paddingLeft: 10,
                minHeight: 34,
              }}
            >
              <button
                type="button"
                onClick={() => setExpandedPacketId(isExpanded ? null : packet.id)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                  padding: 0,
                }}
              >
                {/* Status dot — matches session rows */}
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusMeta.color, boxShadow: `0 0 6px ${statusMeta.border}`, flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 11, fontWeight: 600, lineHeight: 1.35, color: 'var(--t-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '-0.01em' }}>
                    {packet.title}
                  </span>
                  <span style={{ display: 'block', marginTop: 1, fontSize: 9, lineHeight: 1.3, color: 'var(--t-text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {packet.runtime === 'claude-code' ? 'Claude Code' : 'Codex'}
                  </span>
                </span>
                <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 600, color: statusMeta.color, letterSpacing: '-0.01em' }}>
                  {statusMeta.label}
                </span>
                <svg width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="var(--t-text-muted)" strokeWidth="1.5" strokeLinecap="round" style={{ flexShrink: 0, transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 150ms ease' }}>
                  <path d="M2.5 3.5L5 6L7.5 3.5" />
                </svg>
              </button>
              {/* BUG #5 fix: inline Launch so users don't have to expand the card to dispatch.
                  Shown only when the packet is ready to launch (not yet dispatched). */}
              {canLaunch && !packet.lane ? (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); void handleLaunchPacket(packet); }}
                  title="Dispatch this packet"
                  style={{
                    flexShrink: 0,
                    border: 'none',
                    background: '#2563eb',
                    color: '#fff',
                    padding: '4px 10px',
                    borderRadius: 6,
                    fontSize: 10,
                    fontWeight: 700,
                    cursor: 'pointer',
                    letterSpacing: '-0.01em',
                  }}
                >
                  Launch
                </button>
              ) : null}
            </div>

            {isExpanded ? (
              <div style={{ display: 'flex', flexDirection: 'column', borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: 'var(--t-divider-subtle)' }}>
                {/* ── Metadata rows — Issues-style density ── */}
                {(() => {
                  const isEditingSummary = editingField?.packetId === packet.id && editingField.field === 'summary';
                  const isEditingRuntime = editingField?.packetId === packet.id && editingField.field === 'runtime';
                  const isEditingRepo = editingField?.packetId === packet.id && editingField.field === 'repo';
                  const isEditingBranch = editingField?.packetId === packet.id && editingField.field === 'branch';

                  const workspaceLabel = packet.workspaceTargetPath
                    ? (workspaceTargets.find((t) => t.localPath === packet.workspaceTargetPath)?.label ?? packet.workspaceTargetPath.split('/').pop() ?? 'target')
                    : null;

                  const runtimeDisplay = packet.runtime === 'claude-code' ? 'Claude Code' : 'Codex';

                  // Helper for row chrome — matches Issues row density exactly.
                  const rowChromeStyle: React.CSSProperties = {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    minHeight: 28,
                    paddingTop: 5,
                    paddingRight: 10,
                    paddingBottom: 5,
                    paddingLeft: 10,
                    width: '100%',
                    borderWidth: 0,
                    background: 'transparent',
                    textAlign: 'left' as const,
                    cursor: 'pointer',
                    transition: 'background 120ms ease',
                  };
                  const rowLabelStyle: React.CSSProperties = {
                    fontSize: 9,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: 'var(--t-text-muted)',
                    width: 58,
                    flexShrink: 0,
                  };
                  const rowValueStyle: React.CSSProperties = {
                    flex: 1,
                    minWidth: 0,
                    fontSize: 11.5,
                    color: 'var(--t-text)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap' as const,
                    letterSpacing: '-0.005em',
                  };
                  const chevron = (
                    <svg width={9} height={9} viewBox="0 0 10 10" fill="none" stroke="var(--t-text-faint)" strokeWidth="1.5" strokeLinecap="round" style={{ flexShrink: 0, opacity: 0.5 }}>
                      <path d="M2.5 3.5L5 6L7.5 3.5" />
                    </svg>
                  );

                  return (
                    <>
                      {/* Summary row */}
                      <div data-packet-row style={{ borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: 'var(--t-divider-subtle)' }}>
                        {isEditingSummary ? (
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, paddingTop: 6, paddingRight: 10, paddingBottom: 6, paddingLeft: 10 }}>
                            <span style={{ ...rowLabelStyle, paddingTop: 4 }}>summary</span>
                            <textarea
                              autoFocus
                              value={packet.summary}
                              onChange={(event) => patchPacket(packet.id, (current) => ({ ...current, summary: event.target.value }))}
                              onBlur={() => setEditingField(null)}
                              placeholder="What should this packet accomplish?"
                              rows={3}
                              style={{
                                flex: 1,
                                minWidth: 0,
                                paddingTop: 5,
                                paddingRight: 8,
                                paddingBottom: 5,
                                paddingLeft: 8,
                                borderRadius: 6,
                                borderWidth: 1,
                                borderStyle: 'solid',
                                borderColor: 'var(--t-accent-border)',
                                background: 'var(--t-input-bg)',
                                fontSize: 11.5,
                                color: 'var(--t-text)',
                                resize: 'vertical',
                                outline: 'none',
                                lineHeight: 1.45,
                                fontFamily: 'inherit',
                              }}
                            />
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setEditingField({ packetId: packet.id, field: 'summary' })}
                            style={{ ...rowChromeStyle, alignItems: 'flex-start', minHeight: 32 }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-divider-subtle)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                          >
                            <span style={{ ...rowLabelStyle, paddingTop: 2 }}>summary</span>
                            <span
                              style={{
                                flex: 1,
                                minWidth: 0,
                                fontSize: 11.5,
                                color: packet.summary ? 'var(--t-text)' : 'var(--t-text-faint)',
                                lineHeight: 1.45,
                                display: '-webkit-box',
                                WebkitBoxOrient: 'vertical',
                                WebkitLineClamp: 2,
                                overflow: 'hidden',
                                letterSpacing: '-0.005em',
                              } as React.CSSProperties}
                            >
                              {packet.summary || 'What should this packet accomplish?'}
                            </span>
                            {chevron}
                          </button>
                        )}
                      </div>

                      {/* Runtime row */}
                      <div data-packet-row style={{ position: 'relative', borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: 'var(--t-divider-subtle)' }}>
                        <button
                          type="button"
                          onClick={() => setEditingField(isEditingRuntime ? null : { packetId: packet.id, field: 'runtime' })}
                          style={rowChromeStyle}
                          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-divider-subtle)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        >
                          <span style={rowLabelStyle}>runtime</span>
                          <span style={{ ...rowValueStyle, color: orchestratorRuntimeTone(packet.runtime).color, fontWeight: 600 }}>
                            {runtimeDisplay}
                          </span>
                          {chevron}
                        </button>
                        {isEditingRuntime ? (
                          <div
                            style={{
                              position: 'absolute',
                              top: 30,
                              left: 8,
                              right: 8,
                              zIndex: 20,
                              borderRadius: 8,
                              borderWidth: 1,
                              borderStyle: 'solid',
                              borderColor: 'var(--t-divider-subtle)',
                              background: 'var(--t-panel-solid)',
                              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
                              overflow: 'hidden',
                            }}
                          >
                            {(['codex', 'claude-code'] as const).map((runtime) => (
                              <button
                                key={runtime}
                                type="button"
                                onClick={() => {
                                  patchPacket(packet.id, (current) => ({ ...current, runtime }));
                                  setEditingField(null);
                                }}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 6,
                                  width: '100%',
                                  paddingTop: 7,
                                  paddingRight: 10,
                                  paddingBottom: 7,
                                  paddingLeft: 10,
                                  borderWidth: 0,
                                  background: packet.runtime === runtime ? 'var(--t-accent-soft)' : 'transparent',
                                  color: 'var(--t-text)',
                                  fontSize: 11.5,
                                  fontWeight: 500,
                                  cursor: 'pointer',
                                  textAlign: 'left',
                                }}
                                onMouseEnter={(e) => { if (packet.runtime !== runtime) e.currentTarget.style.background = 'var(--t-panel-hover)'; }}
                                onMouseLeave={(e) => { if (packet.runtime !== runtime) e.currentTarget.style.background = 'transparent'; }}
                              >
                                <span style={{ width: 6, height: 6, borderRadius: '50%', background: orchestratorRuntimeTone(runtime).color }} />
                                {runtime === 'claude-code' ? 'Claude Code' : 'Codex'}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>

                      {/* Repo row */}
                      <div data-packet-row style={{ position: 'relative', borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: 'var(--t-divider-subtle)' }}>
                        <button
                          type="button"
                          onClick={() => setEditingField(isEditingRepo ? null : { packetId: packet.id, field: 'repo' })}
                          style={rowChromeStyle}
                          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-divider-subtle)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        >
                          <span style={rowLabelStyle}>repo</span>
                          <span style={{ ...rowValueStyle, color: workspaceLabel ? 'var(--t-text)' : 'var(--t-text-faint)' }}>
                            {workspaceLabel ?? 'No target'}
                          </span>
                          {chevron}
                        </button>
                        {isEditingRepo ? (
                          <div
                            style={{
                              position: 'absolute',
                              top: 30,
                              left: 8,
                              right: 8,
                              zIndex: 20,
                              maxHeight: 220,
                              overflowY: 'auto',
                              borderRadius: 8,
                              borderWidth: 1,
                              borderStyle: 'solid',
                              borderColor: 'var(--t-divider-subtle)',
                              background: 'var(--t-panel-solid)',
                              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
                            }}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                patchPacket(packet.id, (current) => ({ ...current, workspaceTargetPath: null }));
                                setEditingField(null);
                              }}
                              style={{
                                display: 'block',
                                width: '100%',
                                paddingTop: 7,
                                paddingRight: 10,
                                paddingBottom: 7,
                                paddingLeft: 10,
                                borderWidth: 0,
                                background: !packet.workspaceTargetPath ? 'var(--t-accent-soft)' : 'transparent',
                                color: 'var(--t-text-faint)',
                                fontSize: 11,
                                fontStyle: 'italic',
                                cursor: 'pointer',
                                textAlign: 'left',
                              }}
                            >
                              No target
                            </button>
                            {workspaceTargets.map((target) => {
                              const isSelected = target.localPath === packet.workspaceTargetPath;
                              return (
                                <button
                                  key={target.id}
                                  type="button"
                                  onClick={() => {
                                    patchPacket(packet.id, (current) => ({
                                      ...current,
                                      workspaceTargetPath: target.localPath,
                                      branchTarget: target.branch ?? current.branchTarget,
                                    }));
                                    setEditingField(null);
                                  }}
                                  style={{
                                    display: 'block',
                                    width: '100%',
                                    paddingTop: 7,
                                    paddingRight: 10,
                                    paddingBottom: 7,
                                    paddingLeft: 10,
                                    borderWidth: 0,
                                    background: isSelected ? 'var(--t-accent-soft)' : 'transparent',
                                    color: 'var(--t-text)',
                                    fontSize: 11.5,
                                    fontWeight: 500,
                                    cursor: 'pointer',
                                    textAlign: 'left',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                  onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'var(--t-panel-hover)'; }}
                                  onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                                >
                                  {target.label}
                                </button>
                              );
                            })}
                            {workspaceTargets.length === 0 ? (
                              <div style={{ paddingTop: 10, paddingRight: 10, paddingBottom: 10, paddingLeft: 10, fontSize: 11, color: 'var(--t-text-muted)' }}>
                                No workspaces available
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>

                      {/* Branch row */}
                      <div data-packet-row>
                        {isEditingBranch ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 5, paddingRight: 10, paddingBottom: 5, paddingLeft: 10 }}>
                            <span style={rowLabelStyle}>branch</span>
                            <input
                              autoFocus
                              value={packet.branchTarget}
                              onChange={(event) => patchPacket(packet.id, (current) => ({ ...current, branchTarget: event.target.value }))}
                              onBlur={() => setEditingField(null)}
                              onKeyDown={(event) => { if (event.key === 'Enter') setEditingField(null); }}
                              placeholder="branch"
                              style={{
                                flex: 1,
                                minWidth: 0,
                                paddingTop: 4,
                                paddingRight: 8,
                                paddingBottom: 4,
                                paddingLeft: 8,
                                borderRadius: 6,
                                borderWidth: 1,
                                borderStyle: 'solid',
                                borderColor: 'var(--t-accent-border)',
                                background: 'var(--t-input-bg)',
                                fontSize: 11.5,
                                color: 'var(--t-text)',
                                outline: 'none',
                                fontFamily: 'inherit',
                              }}
                            />
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setEditingField({ packetId: packet.id, field: 'branch' })}
                            style={rowChromeStyle}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-divider-subtle)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                          >
                            <span style={rowLabelStyle}>branch</span>
                            <span style={{ ...rowValueStyle, color: packet.branchTarget ? 'var(--t-text)' : 'var(--t-text-faint)', fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)', fontSize: 11 }}>
                              {packet.branchTarget || 'main'}
                            </span>
                            {chevron}
                          </button>
                        )}
                      </div>
                    </>
                  );
                })()}

                {/* ── Blocker notice (if any) ── */}
                {(packet.blockedReason || dependencyBlocker) ? (
                  <div
                    style={{
                      marginTop: 0,
                      paddingTop: 6,
                      paddingRight: 10,
                      paddingBottom: 6,
                      paddingLeft: 10,
                      fontSize: 10.5,
                      fontWeight: 600,
                      color: '#b91c1c',
                      background: 'rgba(239, 68, 68, 0.06)',
                      borderTopWidth: 1,
                      borderTopStyle: 'solid',
                      borderTopColor: 'rgba(239, 68, 68, 0.14)',
                    }}
                  >
                    {packet.blockedReason ?? `Waiting on ${dependencyBlocker?.referenceLabel}`}
                  </div>
                ) : null}

                {/* ── Action footer — ghost secondary, bold primary ── */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    paddingTop: 7,
                    paddingRight: 10,
                    paddingBottom: 7,
                    paddingLeft: 10,
                    borderTopWidth: 1,
                    borderTopStyle: 'solid',
                    borderTopColor: 'var(--t-divider-subtle)',
                  }}
                >
                  {packet.queueState !== 'held' && !packet.lane ? (
                    <button
                      type="button"
                      onClick={() => patchPacket(packet.id, (current) => ({ ...current, queueState: 'held', blockedReason: 'Held by operator' }))}
                      style={{
                        borderWidth: 0,
                        background: 'transparent',
                        color: 'var(--t-text-muted)',
                        paddingTop: 4,
                        paddingRight: 8,
                        paddingBottom: 4,
                        paddingLeft: 8,
                        borderRadius: 5,
                        fontSize: 10.5,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-divider-subtle)'; e.currentTarget.style.color = 'var(--t-text)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--t-text-muted)'; }}
                    >
                      Hold
                    </button>
                  ) : packet.queueState === 'held' ? (
                    <button
                      type="button"
                      onClick={() => patchPacket(packet.id, (current) => ({ ...current, queueState: 'queued', blockedReason: null }))}
                      style={{
                        borderWidth: 0,
                        background: 'transparent',
                        color: '#b91c1c',
                        paddingTop: 4,
                        paddingRight: 8,
                        paddingBottom: 4,
                        paddingLeft: 8,
                        borderRadius: 5,
                        fontSize: 10.5,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(239, 68, 68, 0.08)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      Unhold
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => patchPacket(packet.id, (current) => ({ ...current, archivedAt: current.archivedAt ? null : new Date().toISOString() }))}
                    style={{
                      borderWidth: 0,
                      background: 'transparent',
                      color: 'var(--t-text-muted)',
                      paddingTop: 4,
                      paddingRight: 8,
                      paddingBottom: 4,
                      paddingLeft: 8,
                      borderRadius: 5,
                      fontSize: 10.5,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-divider-subtle)'; e.currentTarget.style.color = 'var(--t-text)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--t-text-muted)'; }}
                  >
                    {packet.archivedAt ? 'Restore' : 'Archive'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      updateMissionState((current) => ({
                        ...current,
                        packets: current.packets.filter((p) => p.id !== packet.id),
                      }));
                    }}
                    style={{
                      borderWidth: 0,
                      background: 'transparent',
                      color: 'var(--t-text-muted)',
                      paddingTop: 4,
                      paddingRight: 8,
                      paddingBottom: 4,
                      paddingLeft: 8,
                      borderRadius: 5,
                      fontSize: 10.5,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(239, 68, 68, 0.08)'; e.currentTarget.style.color = '#ef4444'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--t-text-muted)'; }}
                  >
                    Delete
                  </button>
                  <div style={{ flex: 1 }} />
                  {!packet.lane ? (
                    <button
                      type="button"
                      onClick={() => { void handleLaunchPacket(packet); }}
                      disabled={!canLaunch}
                      style={{
                        borderWidth: 0,
                        background: canLaunch ? '#2563eb' : 'var(--t-divider)',
                        color: canLaunch ? '#fff' : 'var(--t-text-faint)',
                        paddingTop: 4,
                        paddingRight: 10,
                        paddingBottom: 4,
                        paddingLeft: 10,
                        borderRadius: 5,
                        fontSize: 10.5,
                        fontWeight: 700,
                        cursor: canLaunch ? 'pointer' : 'default',
                        letterSpacing: '-0.01em',
                      }}
                    >
                      Launch
                    </button>
                  ) : (
                    <>
                      {packet.lane?.laneId && (packet.status === 'idle' || packet.status === 'awaiting_review' || packet.status === 'recovering') ? (
                        <button
                          type="button"
                          onClick={() => {
                            fetch('/api/lanes', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ verb: 'resume', laneId: packet.lane?.laneId, message: 'Continue the previous task.', actor: 'user' }),
                            }).catch(() => {});
                          }}
                          style={{
                            borderWidth: 0,
                            background: 'transparent',
                            color: '#2563eb',
                            paddingTop: 4,
                            paddingRight: 8,
                            paddingBottom: 4,
                            paddingLeft: 8,
                            borderRadius: 5,
                            fontSize: 10.5,
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(37, 99, 235, 0.08)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        >
                          Resume
                        </button>
                      ) : null}
                      {hasInteractiveLane ? (
                        <button
                          type="button"
                          onClick={() => handleFocusPacket(packet)}
                          style={{
                            borderWidth: 0,
                            background: '#2563eb',
                            color: '#fff',
                            paddingTop: 4,
                            paddingRight: 10,
                            paddingBottom: 4,
                            paddingLeft: 10,
                            borderRadius: 5,
                            fontSize: 10.5,
                            fontWeight: 700,
                            cursor: 'pointer',
                            letterSpacing: '-0.01em',
                          }}
                        >
                          Focus
                        </button>
                      ) : null}
                    </>
                  )}
                </div>

                {showReviewSection ? (
                  <div style={{
                    borderRadius: 14,
                    background: 'var(--t-panel)',
                    border: '1px solid var(--t-panel-border)',
                    padding: '10px 11px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text)' }}>
                        Review
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--t-text-secondary)' }}>
                        {reviewState?.loading
                          ? 'Loading review...'
                          : reviewState?.snapshot?.diffStat?.trim()
                            ? reviewState.snapshot.diffStat
                            : `${reviewFileCount} files changed, +${reviewAdditions} -${reviewDeletions}`}
                      </div>
                    </div>

                    {reviewWarningText ? (
                      <div style={{ fontSize: 11, fontWeight: 600, color: '#b45309', padding: '7px 9px', borderRadius: 8, background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.16)' }}>
                        {reviewWarningText}
                      </div>
                    ) : null}

                    {reviewState?.error ? (
                      <div style={{ fontSize: 11, fontWeight: 600, color: '#b91c1c', padding: '7px 9px', borderRadius: 8, background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239, 68, 68, 0.12)' }}>
                        {reviewState.error}
                      </div>
                    ) : null}

                    {!reviewState?.error && reviewState?.loading ? (
                      <div style={{ fontSize: 11, color: 'var(--t-text-secondary)', opacity: 0.7 }}>
                        Loading review snapshot...
                      </div>
                    ) : null}

                    {!reviewState?.loading && reviewFiles.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {visibleReviewFiles.map((file) => {
                          const statusTone = file.status === 'added'
                            ? { color: '#16a34a', background: 'rgba(34, 197, 94, 0.08)', border: 'rgba(34, 197, 94, 0.18)' }
                            : file.status === 'deleted'
                              ? { color: '#dc2626', background: 'rgba(239, 68, 68, 0.08)', border: 'rgba(239, 68, 68, 0.16)' }
                              : file.status === 'renamed'
                                ? { color: '#7c3aed', background: 'rgba(139, 92, 246, 0.08)', border: 'rgba(139, 92, 246, 0.16)' }
                                : file.status === 'untracked'
                                  ? { color: '#0f766e', background: 'rgba(20, 184, 166, 0.08)', border: 'rgba(20, 184, 166, 0.16)' }
                                  : { color: '#2563eb', background: 'rgba(37, 99, 235, 0.08)', border: 'rgba(37, 99, 235, 0.16)' };
                          return (
                            <div key={`${packet.id}:${file.path}`} style={{
                              display: 'grid',
                              gridTemplateColumns: '1fr auto auto',
                              gap: 8,
                              alignItems: 'center',
                              padding: '7px 8px',
                              borderRadius: 10,
                              background: 'rgba(148, 163, 184, 0.06)',
                              border: '1px solid rgba(148, 163, 184, 0.12)',
                            }}>
                              <span style={{
                                fontSize: 11,
                                color: 'var(--t-text)',
                                fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}>
                                {file.path}
                              </span>
                              <span style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                                padding: '2px 6px',
                                borderRadius: 999,
                                border: `1px solid ${statusTone.border}`,
                                background: statusTone.background,
                                color: statusTone.color,
                                fontSize: 10,
                                fontWeight: 700,
                                textTransform: 'capitalize',
                              }}>
                                {file.status}
                              </span>
                              <span style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 6,
                                fontSize: 11,
                                fontWeight: 700,
                                fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
                              }}>
                                <span style={{ color: '#16a34a' }}>+{Math.max(0, file.additions ?? 0)}</span>
                                <span style={{ color: '#dc2626' }}>-{Math.max(0, file.deletions ?? 0)}</span>
                              </span>
                            </div>
                          );
                        })}
                        {reviewFiles.length > 5 ? (
                          <button
                            type="button"
                            onClick={() => updateReviewState(packet.id, (current) => ({ ...current, showAllFiles: !current.showAllFiles }))}
                            style={{
                              border: 'none',
                              background: 'transparent',
                              color: '#2563eb',
                              fontSize: 11,
                              fontWeight: 700,
                              cursor: 'pointer',
                              padding: 0,
                              alignSelf: 'flex-start',
                            }}
                          >
                            {reviewState?.showAllFiles ? 'Show less' : `Show all ${reviewFiles.length} files`}
                          </button>
                        ) : null}
                      </div>
                    ) : null}

                    {!reviewState?.loading && !reviewState?.error && reviewFiles.length === 0 ? (
                      <div style={{ fontSize: 11, color: 'var(--t-text-secondary)' }}>
                        Working tree clean.
                      </div>
                    ) : null}

                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        onClick={() => { void handleReviewAction(packet, 'create_pr'); }}
                        disabled={reviewState?.action === 'create_pr' || reviewState?.loading}
                        style={{
                          border: '1px solid rgba(34, 197, 94, 0.25)',
                          background: 'rgba(34, 197, 94, 0.08)',
                          color: '#16a34a',
                          padding: '6px 10px',
                          borderRadius: 8,
                          fontSize: 11,
                          fontWeight: 700,
                          cursor: reviewState?.action === 'create_pr' || reviewState?.loading ? 'default' : 'pointer',
                          opacity: reviewState?.action === 'create_pr' || reviewState?.loading ? 0.5 : 1,
                        }}
                      >
                        {reviewState?.action === 'create_pr' ? 'Create PR...' : 'Create PR'}
                      </button>
                      <button
                        type="button"
                        onClick={() => { void handleReviewAction(packet, 'merge'); }}
                        disabled={reviewState?.action === 'merge' || reviewState?.loading}
                        style={{
                          border: '1px solid rgba(37, 99, 235, 0.2)',
                          background: 'rgba(37, 99, 235, 0.06)',
                          color: '#2563eb',
                          padding: '6px 10px',
                          borderRadius: 8,
                          fontSize: 11,
                          fontWeight: 700,
                          cursor: reviewState?.action === 'merge' || reviewState?.loading ? 'default' : 'pointer',
                          opacity: reviewState?.action === 'merge' || reviewState?.loading ? 0.5 : 1,
                        }}
                      >
                        {reviewState?.action === 'merge' ? 'Merge...' : 'Merge'}
                      </button>
                      {reviewState?.prUrl ? (
                        <a
                          href={reviewState.prUrl}
                          target="_blank"
                          rel="noreferrer"
                          style={{ fontSize: 11, fontWeight: 700, color: '#2563eb', textDecoration: 'none' }}
                        >
                          Open PR
                        </a>
                      ) : null}
                    </div>

                    {reviewState?.actionError ? (
                      <div style={{ fontSize: 11, fontWeight: 600, color: '#b91c1c' }}>
                        {reviewState.actionError}
                      </div>
                    ) : null}

                    {!reviewState?.actionError && reviewState?.actionNote ? (
                      <div style={{ fontSize: 11, color: 'var(--t-text-secondary)' }}>
                        {reviewState.actionNote}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <div style={{ padding: '0 14px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>{runtimeMeta.label}</span>
                {targetLabel ? <><span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>·</span><span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>{targetLabel}</span></> : null}
                {packet.lane ? <><span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>·</span><span style={{ fontSize: 10, color: '#22c55e', fontWeight: 600 }}>Live</span></> : null}
                {packet.lane?.laneId ? <><span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>·</span><span style={{ fontSize: 10, color: 'var(--t-text-muted)', fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)' }}>{packet.lane.laneId.slice(0, 12)}</span></> : null}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */
});
