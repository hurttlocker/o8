'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
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
  const [reviewStateByPacketId, setReviewStateByPacketId] = useState<Record<string, ReviewPanelState>>({});
  const issuesRepoSlugRef = useRef<string | null>(null);
  const missionPromptRef = useRef<HTMLTextAreaElement>(null);

  void issuesLoading;

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

    // Re-poll every 30s with fresh=1 so new issues appear automatically
    const pollTimer = setInterval(() => { void fetchIssues(true); }, 30_000);

    return () => { cancelled = true; clearInterval(pollTimer); };
  }, [open, visible, workspaceTargets]);

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
      padding: '12px',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      background: thoughtsBodyBackground,
      minHeight: 0,
    }}>
      <div style={{
        padding: '16px 18px',
        borderRadius: 18,
        background: thoughtsElevatedSurface,
        border: thoughtsElevatedBorder,
        boxShadow: thoughtsElevatedShadow,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--t-text)', letterSpacing: '-0.02em' }}>
              Mission Control
            </div>
            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.5, maxWidth: 420 }}>
              Thoughts owns planning and routing. Workspace tabs and worktrees stay visible as the execution lanes.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 9px',
              borderRadius: 999,
              background: thoughtsMutedGlass,
              border: thoughtsElevatedBorder,
              fontSize: 10,
              fontWeight: 700,
              color: 'var(--t-text-secondary)',
            }}>
              Default runtime
              <span style={{ color: orchestratorRuntimeTone(preferredRuntime).color }}>
                {orchestratorRuntimeTone(preferredRuntime).label}
              </span>
            </span>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 9px',
              borderRadius: 999,
              background: thoughtsMutedGlass,
              border: thoughtsElevatedBorder,
              fontSize: 10,
              fontWeight: 700,
              color: 'var(--t-text-secondary)',
            }}>
              Live lanes
              <span style={{ color: 'var(--t-text)' }}>{sessionTargets.length}</span>
            </span>
          </div>
        </div>

        <div style={{ position: 'relative' }}>
          <textarea
            ref={missionPromptRef}
            value={missionState.prompt}
            onChange={(event) => handleMissionPromptChange(event.target.value)}
            placeholder="Describe the mission. Thoughts will break it into visible work packets and let you route them into workspace lanes."
            style={{
              width: '100%',
              minHeight: 94,
              padding: '12px 14px',
              borderRadius: 14,
              border: '1px solid var(--t-input-border)',
              background: 'var(--t-input-bg)',
              fontSize: 13,
              color: 'var(--t-text)',
              resize: 'vertical',
              outline: 'none',
              fontFamily: 'inherit',
              lineHeight: 1.5,
              boxSizing: 'border-box',
            }}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 11, color: 'var(--t-text-muted)', lineHeight: 1.45 }}>
            Manual by design for v1. Queue, launch, and focus are explicit. No hidden worker spawning.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              onClick={handleAddPacket}
              style={{
                border: '1px solid var(--t-panel-border)',
                background: 'var(--t-panel)',
                color: 'var(--t-text-secondary)',
                padding: '8px 12px',
                borderRadius: 12,
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Add Packet
            </button>
            <button
              type="button"
              onClick={handlePlanMission}
              disabled={!missionState.prompt.trim()}
              style={{
                border: 'none',
                background: missionState.prompt.trim() ? '#2563eb' : 'var(--t-divider)',
                color: missionState.prompt.trim() ? '#fff' : 'var(--t-text-faint)',
                padding: '8px 12px',
                borderRadius: 12,
                fontSize: 11,
                fontWeight: 700,
                cursor: missionState.prompt.trim() ? 'pointer' : 'default',
              }}
            >
              Plan Packets
            </button>
          </div>
        </div>
      </div>

      {missionState.summary ? (
        <div style={{
          padding: '12px 14px',
          borderRadius: 16,
          background: 'var(--t-panel)',
          border: '1px solid var(--t-panel-border)',
          boxShadow: '0 12px 28px rgba(15, 23, 42, 0.05)',
        }}>
          <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--t-text-muted)', marginBottom: 6 }}>
            Mission Summary
          </div>
          <div style={{ fontSize: 13, color: 'var(--t-text)', lineHeight: 1.55 }}>
            {missionState.summary}
          </div>
        </div>
      ) : null}

      {repoIssues.length > 0 ? (
        <div style={{
          padding: '14px 16px',
          borderRadius: 16,
          background: 'var(--t-panel)',
          border: '1px solid var(--t-panel-border)',
          boxShadow: '0 12px 28px rgba(15, 23, 42, 0.04)',
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

      {missionState.packets.length === 0 ? (
        <div style={{
          padding: '18px 16px',
          borderRadius: 16,
          border: '1px dashed var(--t-panel-border)',
          background: 'rgba(148, 163, 184, 0.06)',
          color: 'var(--t-text-secondary)',
          fontSize: 12,
          lineHeight: 1.6,
          textAlign: 'center',
        }}>
          Add packets from issues above, or describe a mission and plan.
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

        return (
          <div
            key={packet.id}
            style={{
              borderRadius: 14,
              background: 'var(--t-panel)',
              border: '1px solid var(--t-panel-border)',
              boxShadow: '0 8px 20px rgba(15, 23, 42, 0.04)',
              flexShrink: 0,
            }}
          >
            <button
              type="button"
              onClick={() => setExpandedPacketId(isExpanded ? null : packet.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                padding: '11px 14px',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 10, fontWeight: 800, color: runtimeMeta.color, padding: '2px 6px', borderRadius: 5, background: runtimeMeta.background, flexShrink: 0, letterSpacing: '0.02em' }}>
                {packet.referenceLabel}
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '-0.01em' }}>
                {packet.title}
              </span>
              <span style={{ fontSize: 9, fontWeight: 800, color: statusMeta.color, padding: '3px 7px', borderRadius: 999, background: statusMeta.background, border: `1px solid ${statusMeta.border}`, textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>
                {statusMeta.label}
              </span>
              <svg width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="var(--t-text-muted)" strokeWidth="1.5" strokeLinecap="round" style={{ flexShrink: 0, transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 150ms ease' }}>
                <path d="M2.5 3.5L5 6L7.5 3.5" />
              </svg>
            </button>

            {isExpanded ? (
              <div style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid var(--t-divider-subtle)' }}>
                <div style={{ paddingTop: 10 }}>
                  <textarea
                    value={packet.summary}
                    onChange={(event) => patchPacket(packet.id, (current) => ({ ...current, summary: event.target.value }))}
                    placeholder="What should this packet accomplish?"
                    rows={2}
                    style={{
                      width: '100%',
                      padding: '9px 11px',
                      borderRadius: 10,
                      border: '1px solid var(--t-input-border)',
                      background: 'var(--t-input-bg)',
                      fontSize: 12,
                      color: 'var(--t-text)',
                      resize: 'vertical',
                      outline: 'none',
                      lineHeight: 1.5,
                      boxSizing: 'border-box',
                    }}
                  />
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <select
                    value={packet.runtime}
                    onChange={(event) => patchPacket(packet.id, (current) => ({ ...current, runtime: event.target.value === 'claude-code' ? 'claude-code' : 'codex' }))}
                    style={{ padding: '5px 8px', borderRadius: 8, border: '1px solid var(--t-input-border)', background: 'var(--t-input-bg)', color: 'var(--t-text)', fontSize: 11 }}
                  >
                    <option value="codex">Codex</option>
                    <option value="claude-code">Claude Code</option>
                  </select>
                  <select
                    value={packet.workspaceTargetPath ?? ''}
                    onChange={(event) => {
                      const nextTarget = workspaceTargets.find((target) => target.localPath === event.target.value) ?? null;
                      patchPacket(packet.id, (current) => ({ ...current, workspaceTargetPath: nextTarget?.localPath ?? null, branchTarget: nextTarget?.branch ?? current.branchTarget }));
                    }}
                    style={{ padding: '5px 8px', borderRadius: 8, border: '1px solid var(--t-input-border)', background: 'var(--t-input-bg)', color: 'var(--t-text)', fontSize: 11 }}
                  >
                    <option value="">No target</option>
                    {workspaceTargets.map((target) => <option key={target.id} value={target.localPath}>{target.label}</option>)}
                  </select>
                  <input
                    value={packet.branchTarget}
                    onChange={(event) => patchPacket(packet.id, (current) => ({ ...current, branchTarget: event.target.value }))}
                    placeholder="branch"
                    style={{ padding: '5px 8px', borderRadius: 8, border: '1px solid var(--t-input-border)', background: 'var(--t-input-bg)', color: 'var(--t-text)', fontSize: 11, outline: 'none', width: 90 }}
                  />
                </div>

                {(packet.blockedReason || dependencyBlocker) ? (
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#b91c1c', padding: '7px 10px', borderRadius: 8, background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239, 68, 68, 0.12)' }}>
                    {packet.blockedReason ?? `Waiting on ${dependencyBlocker?.referenceLabel}`}
                  </div>
                ) : null}

                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {!packet.lane ? (
                    <button type="button" onClick={() => { void handleLaunchPacket(packet); }} disabled={!canLaunch}
                      style={{ border: 'none', background: canLaunch ? '#2563eb' : 'var(--t-divider)', color: canLaunch ? '#fff' : 'var(--t-text-faint)', padding: '6px 12px', borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: canLaunch ? 'pointer' : 'default' }}>
                      Launch
                    </button>
                  ) : (
                    <>
                      {hasInteractiveLane ? (
                        <button type="button" onClick={() => handleFocusPacket(packet)}
                          style={{ border: 'none', background: '#2563eb', color: '#fff', padding: '6px 12px', borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                          Focus
                        </button>
                      ) : null}
                      {packet.lane?.laneId && (packet.status === 'idle' || packet.status === 'awaiting_review' || packet.status === 'recovering') ? (
                        <button type="button" onClick={() => {
                          fetch('/api/lanes', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ verb: 'resume', laneId: packet.lane?.laneId, message: 'Continue the previous task.', actor: 'user' }),
                          }).catch(() => {});
                        }}
                          style={{ border: '1px solid rgba(37, 99, 235, 0.2)', background: 'rgba(37, 99, 235, 0.06)', color: '#2563eb', padding: '6px 10px', borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                          Resume
                        </button>
                      ) : null}
                    </>
                  )}
                  {packet.queueState !== 'held' && !packet.lane ? (
                    <button type="button" onClick={() => patchPacket(packet.id, (current) => ({ ...current, queueState: 'held', blockedReason: 'Held by operator' }))}
                      style={{ border: '1px solid var(--t-panel-border)', background: 'var(--t-panel)', color: 'var(--t-text-secondary)', padding: '6px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                      Hold
                    </button>
                  ) : packet.queueState === 'held' ? (
                    <button type="button" onClick={() => patchPacket(packet.id, (current) => ({ ...current, queueState: 'queued', blockedReason: null }))}
                      style={{ border: '1px solid rgba(239, 68, 68, 0.2)', background: 'rgba(239, 68, 68, 0.06)', color: '#b91c1c', padding: '6px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                      Unhold
                    </button>
                  ) : null}
                  <button type="button"
                    onClick={() => patchPacket(packet.id, (current) => ({ ...current, archivedAt: current.archivedAt ? null : new Date().toISOString() }))}
                    style={{ border: '1px solid var(--t-panel-border)', background: 'var(--t-panel)', color: 'var(--t-text-muted)', padding: '6px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: 'pointer', marginLeft: 'auto' }}>
                    {packet.archivedAt ? 'Restore' : 'Archive'}
                  </button>
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
});
