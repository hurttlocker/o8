'use client';

/**
 * O8ActivityPacketRow — packet row inside the O8 Panel Activity timeline.
 *
 * Mission-rail consolidation, commit 2: this row is now the SOLE
 * packet-control surface (the right-side Mission rail in OrchestratorTab
 * has been deleted). The collapsed row renders inline with the activity
 * feed; the expanded body reuses the existing PacketCard component so
 * Summary/Runtime/Repo/Branch rows, the AGENTS/CONTEXT/CHANGES/FILES
 * tab strip, the DETAILS popover, the retry/reset/open/copy actions,
 * and the Hold/Archive/Delete/Launch + Resume + Focus buttons all
 * survive the migration.
 *
 * All packet-lifecycle wiring (patch / launch / focus / delete / review
 * action / resume / review-snapshot fetch) lives here, mirrored from the
 * old ThoughtsMissionPanel implementation. Self-contained per-row so the
 * Activity timeline can host packets without lifting state into the pane.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { orchestratorStatusTone } from '@/lib/orchestrator/display';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { useOrchestratorData } from '../orchestrator-data-context';
import { relativeAge } from '../agent-panel/shared';
import { PacketCard } from '../thoughts/mission-panel/PacketCard';
import { PacketCloseUnmergedActions } from '../thoughts/mission-panel/PacketCloseUnmergedActions';
import type { EditingField, ReviewPanelState } from '../thoughts/mission-panel/types';

interface O8ActivityPacketRowProps {
  packet: OrchestratorPacket;
  isExpanded: boolean;
  onToggleExpanded: () => void;
}

const EMPTY_REVIEW_STATE: ReviewPanelState = {
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

const FOCUS_LANE_EVENT = 'o8:focus-spawned-agent-lane';

function O8ActivityPacketRowBase({ packet, isExpanded, onToggleExpanded }: O8ActivityPacketRowProps) {
  const data = useOrchestratorData();
  const statusMeta = orchestratorStatusTone(packet.status);
  const targetLabel = data?.workspaceTargets?.find((t) => t.localPath === packet.workspaceTargetPath)?.label
    ?? packet.workspaceTargetPath?.split('/').pop()
    ?? null;
  const allPackets = data?.missionState?.packets ?? [];

  const ageSource = packet.lane?.lastEventAt ?? packet.lastEventAt ?? null;
  const ageLabel = ageSource ? relativeAge(ageSource) : '';
  const repoBranchLabel = [targetLabel, packet.branchTarget?.trim()].filter(Boolean).join('·');

  // ── Per-row state for PacketCard's expanded body ──────────────────────
  const [editingField, setEditingField] = useState<EditingField>(null);
  const [reviewState, setReviewState] = useState<ReviewPanelState>(EMPTY_REVIEW_STATE);
  const reviewLoadedKeyRef = useRef<string | null>(null);
  const changedFiles = reviewState.snapshot?.changedFiles ?? [];
  const additions = changedFiles.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = changedFiles.reduce((sum, file) => sum + (file.deletions ?? 0), 0);

  // Derive a remote-url map so PacketCard can resolve issue URLs the same
  // way ThoughtsMissionPanel did. Workspace targets carry remoteUrl on
  // some shapes but not all — pass through whatever we have.
  const repoRemoteUrlByPath = useMemo<Record<string, string | null | undefined>>(() => {
    const map: Record<string, string | null | undefined> = {};
    for (const target of data?.workspaceTargets ?? []) {
      const remote = (target as unknown as { remoteUrl?: string | null }).remoteUrl ?? null;
      if (target.localPath) map[target.localPath] = remote;
    }
    return map;
  }, [data?.workspaceTargets]);

  // ── Mission-state mutators ────────────────────────────────────────────
  const patchPacket = useCallback(
    (updater: (current: OrchestratorPacket) => OrchestratorPacket) => {
      data?.onMissionStateChange?.((current) => ({
        ...current,
        packets: current.packets.map((p) => (p.id === packet.id ? updater(p) : p)),
      }));
    },
    [data, packet.id],
  );

  const handleDelete = useCallback(() => {
    data?.onMissionStateChange?.((current) => ({
      ...current,
      packets: current.packets.filter((p) => p.id !== packet.id),
    }));
  }, [data, packet.id]);

  const handleLaunch = useCallback(async () => {
    try {
      const binding = await data?.onLaunchPacket?.(packet);
      patchPacket((current) => ({
        ...current,
        queueState: 'queued',
        status: binding ? 'idle' : current.status,
        blockedReason: null,
        lane: binding ?? current.lane ?? null,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to launch this packet.';
      console.error('[o8-activity-packet] launch failed:', error);
      patchPacket((current) => ({ ...current, blockedReason: message }));
    }
  }, [data, packet, patchPacket]);

  const handleFocus = useCallback(() => {
    if (typeof window !== 'undefined' && (packet.lane?.laneId || packet.lane?.sessionKey || packet.id)) {
      window.dispatchEvent(new CustomEvent(FOCUS_LANE_EVENT, {
        detail: {
          packetId: packet.id,
          laneId: packet.lane?.laneId ?? null,
          sessionKey: packet.lane?.sessionKey ?? packet.lane?.tabId ?? null,
          title: packet.title,
        },
      }));
      return;
    }
    const sessionKey = packet.lane?.sessionKey ?? packet.lane?.tabId ?? null;
    if (sessionKey) {
      data?.onSelectSession?.(sessionKey);
      return;
    }
    // Fall back to the workspace pane pivot when no live session is bound.
    data?.onSelectedPacketChange?.(packet.id);
  }, [data, packet]);

  const handleRowClick = useCallback(() => {
    handleFocus();
    onToggleExpanded();
  }, [handleFocus, onToggleExpanded]);

  const handleOpenReviewDiff = useCallback(() => {
    const laneId = packet.lane?.laneId;
    if (!laneId) return;
    data?.onOpenO8Panel?.({ repoPath: packet.workspaceTargetPath, tab: 'review', reviewLaneId: laneId });
  }, [data, packet.lane?.laneId, packet.workspaceTargetPath]);

  const handleResume = useCallback(() => {
    const laneId = packet.lane?.laneId;
    if (!laneId) return;
    fetch('/api/lanes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verb: 'resume', laneId, message: 'Continue the previous task.', actor: 'user' }),
    }).catch(() => {});
  }, [packet.lane?.laneId]);

  const handleStop = useCallback(() => {
    const laneId = packet.lane?.laneId;
    if (!laneId) return;
    // Optimistic: flip the card to a held/blocked state immediately so the Stop
    // button can't be re-clicked while the interrupt round-trips. The server's
    // operatorStopped flag is the source of truth; the next state poll reconciles.
    patchPacket((current) => ({
      ...current,
      operatorStopped: true,
      queueState: 'held',
      status: 'blocked',
      blockedReason: 'operator_stopped',
    }));
    fetch('/api/lanes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verb: 'stop', laneId, actor: 'user' }),
    }).catch(() => {});
  }, [packet.lane?.laneId, patchPacket]);

  const handleCloseUnmerged = useCallback(() => {
    data?.onMissionStateChange?.((current) => ({
      ...current,
      packets: current.packets.map((candidate) => candidate.id === packet.id
        ? {
            ...candidate,
            status: 'archived',
            queueState: 'held',
            archivedAt: new Date().toISOString(),
            blockedReason: null,
            lastEventLabel: 'closed_unmerged',
          }
        : candidate),
    }));
  }, [data, packet.id]);

  const handleReviewAction = useCallback(
    async (verb: 'create_pr' | 'merge') => {
      const laneId = packet.lane?.laneId;
      if (!laneId) return;
      setReviewState((current) => ({
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
        setReviewState((current) => ({
          ...current,
          action: null,
          actionError: null,
          actionNote: note,
          prUrl: prUrl ?? current.prUrl,
        }));
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : verb === 'create_pr'
            ? 'Unable to create PR.'
            : 'Unable to merge this lane.';
        setReviewState((current) => ({ ...current, action: null, actionError: message }));
      }
    },
    [packet.lane?.laneId, packet.title],
  );

  const handleToggleShowAllFiles = useCallback(() => {
    setReviewState((current) => ({ ...current, showAllFiles: !current.showAllFiles }));
  }, []);

  // ── Review-snapshot fetcher (mirrors ThoughtsMissionPanel:525-631) ─────
  // Fires when this row is expanded AND the packet is awaiting_review.
  useEffect(() => {
    if (!isExpanded) return;
    if (packet.status !== 'awaiting_review') return;
    const laneId = packet.lane?.laneId;
    if (!laneId) return;
    const cacheKey = `${packet.id}:${laneId}`;
    if (reviewLoadedKeyRef.current === cacheKey && reviewState.loaded) return;
    if (reviewState.loading) return;

    let cancelled = false;
    setReviewState((current) => ({
      ...current,
      loading: true,
      loaded: false,
      laneId,
      error: null,
    }));

    (async () => {
      try {
        const laneRes = await fetch(`/api/lanes/${encodeURIComponent(laneId)}`);
        const laneData = await laneRes.json().catch(() => null) as {
          lane?: { worktreePath?: string | null; repoPath?: string | null };
          note?: string;
        } | null;
        if (!laneRes.ok) throw new Error(laneData?.note ?? 'Unable to load lane details.');

        const worktreePath = laneData?.lane?.worktreePath ?? null;
        const repoPath = packet.workspaceTargetPath ?? laneData?.lane?.repoPath ?? null;
        if (!worktreePath) {
          if (cancelled) return;
          setReviewState((current) => ({
            ...current,
            loading: false,
            loaded: true,
            laneId,
            worktreePath: null,
            repoPath,
            snapshot: null,
            error: 'No worktree path for this lane yet.',
          }));
          reviewLoadedKeyRef.current = cacheKey;
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
          setReviewState((current) => ({
            ...current,
            loading: false,
            loaded: true,
            laneId,
            worktreePath,
            repoPath,
            snapshot: null,
            error: reviewData?.note ?? 'Unable to load review snapshot.',
          }));
          reviewLoadedKeyRef.current = cacheKey;
          return;
        }
        setReviewState((current) => ({
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
        reviewLoadedKeyRef.current = cacheKey;
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'Unable to load review snapshot.';
        setReviewState((current) => ({
          ...current,
          loading: false,
          loaded: true,
          laneId,
          error: message,
        }));
      }
    })();

    return () => { cancelled = true; };
  }, [isExpanded, packet.id, packet.status, packet.lane?.laneId, packet.workspaceTargetPath, reviewState.loaded, reviewState.loading]);

  return (
    <div>
      <button
        type="button"
        onClick={handleRowClick}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          width: '100%',
          paddingTop: 7,
          paddingRight: 14,
          paddingBottom: 7,
          paddingLeft: 14,
          border: 'none',
          background: isExpanded ? 'var(--t-input-bg)' : 'transparent',
          cursor: 'pointer',
          textAlign: 'left',
          transition: 'background 100ms cubic-bezier(0.22, 1, 0.36, 1)',
          fontFamily: 'var(--font-sans-system)',
        }}
        onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.background = 'var(--t-hover)'; }}
        onMouseLeave={(e) => { if (!isExpanded) e.currentTarget.style.background = 'transparent'; }}
      >
        <div
          style={{
            width: 10,
            height: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            color: 'var(--t-text-faint)',
            transition: 'transform 150ms cubic-bezier(0.22, 1, 0.36, 1)',
            transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
        >
          <svg width="7" height="7" viewBox="0 0 7 7" fill="currentColor"><path d="M1.5 0.5L5.5 3.5L1.5 6.5Z" /></svg>
        </div>

        <div
          style={{
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: statusMeta.background,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            marginTop: 1,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: statusMeta.color,
              boxShadow: `0 0 6px ${statusMeta.border}`,
            }}
          />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13.5,
              color: 'var(--t-text)',
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: 2,
              lineHeight: 1.25,
              fontWeight: 300,
              letterSpacing: '-0.1px',
            }}
          >
            {packet.title}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 6,
              marginTop: 4,
              fontSize: 9.5,
              fontWeight: 260,
              letterSpacing: '-0.4px',
              color: 'var(--t-text-faint)',
              fontFamily: 'var(--font-sans-system)',
              lineHeight: 1.25,
            }}
          >
            <span style={{ color: 'var(--t-terminal-ansi-bright-green, #16a34a)' }}>
              +{additions}
            </span>
            <span style={{ color: 'var(--t-terminal-ansi-bright-red, #dc2626)' }}>
              -{deletions}
            </span>
            <span style={{ color: 'var(--t-text-faint)' }}>·</span>
            <span>{changedFiles.length} files</span>
            {repoBranchLabel ? (
              <>
                <span style={{ color: 'var(--t-text-faint)' }}>·</span>
                <span>{repoBranchLabel}</span>
              </>
            ) : null}
            {ageLabel ? (
              <>
                <span style={{ color: 'var(--t-text-faint)' }}>·</span>
                <span>{ageLabel}</span>
              </>
            ) : null}
          </div>
        </div>

        <span
          style={{
            paddingTop: 1,
            paddingRight: 6,
            paddingBottom: 1,
            paddingLeft: 6,
            borderRadius: 999,
            fontSize: 9,
            fontWeight: 300,
            flexShrink: 0,
            marginTop: 4,
            background: `${statusMeta.color}1a`,
            color: statusMeta.color,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          {statusMeta.label}
        </span>
      </button>

      {isExpanded ? (
        <div
          style={{
            paddingTop: 6,
            paddingRight: 12,
            paddingBottom: 10,
            paddingLeft: 12,
            borderBottom: '1px solid var(--t-panel-border, rgba(0,0,0,0.06))',
          }}
        >
          <PacketCard
            packet={packet}
            allPackets={allPackets}
            isExpanded
            onToggleExpanded={onToggleExpanded}
            editingField={editingField}
            onEditingFieldChange={setEditingField}
            workspaceTargets={data?.workspaceTargets ?? []}
            repoRemoteUrlByPath={repoRemoteUrlByPath}
            reviewState={reviewState}
            onPatch={patchPacket}
            onLaunch={handleLaunch}
            onFocus={handleFocus}
            onDelete={handleDelete}
            onReviewAction={(verb) => { void handleReviewAction(verb); }}
            onToggleShowAllFiles={handleToggleShowAllFiles}
            onResume={handleResume}
            onStop={handleStop}
            onOpenReviewDiff={handleOpenReviewDiff}
          />
          {packet.status === 'awaiting_review' ? (
            <PacketCloseUnmergedActions packetId={packet.id} onClosed={handleCloseUnmerged} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const O8ActivityPacketRow = memo(O8ActivityPacketRowBase);
