import type { MergePreviewResult } from '@/lib/lane/preview-merge';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import type { MergeOrderRecommendation } from '@/lib/worktree/conflicts';
import type { WorktreeInfo } from '@/lib/worktree/types';
import type { ApproveAndMergeInput, MergePacketResult, PickComparisonWinnerInput } from './types';
import { autoResolveMergedPacketVerificationIncidents } from '@/lib/supervisor/merged-incident-resolution';

type LaneRegistryModule = typeof import('@/lib/lane/registry');
type ActivePacketLane = NonNullable<ReturnType<LaneRegistryModule['findLatestLaneByPacket']>>;

const loadApprovalsStore = () => import('@/lib/approvals/store');
const loadDirectiveMerges = () => import('@/lib/cortex/directive-merges');
const loadLaneCommands = () => import('@/lib/lane/commands');
const loadPreviewMerge = () => import('@/lib/lane/preview-merge');
const loadLaneRegistry = () => import('@/lib/lane/registry');
const loadLaneEvents = () => import('@/lib/lane/events');
const loadReviewHeadIntegrity = () => import('@/lib/lane/review-head-integrity');
const loadControlPlane = () => import('@/lib/orchestrator/control-plane');
const loadDag = () => import('@/lib/orchestrator/dag');
const loadDispatch = () => import('@/lib/orchestrator/dispatch');
const loadWorktreeCleanup = () => import('@/lib/orchestrator/worktree-cleanup');
const loadWorktreeConflicts = () => import('@/lib/worktree/conflicts');
const loadWorktreeLaunch = () => import('@/lib/worktree/launch');
const loadMergeTruth = () => import('./merge-truth');
const loadPostMergeCleanup = () => import('./post-merge-cleanup');
const loadReviewCarry = () => import('./review-carry');
const loadReview = () => import('./review');
const loadShared = () => import('./shared');

export async function warmMergePath() {
  await Promise.all([
    loadApprovalsStore(),
    loadDirectiveMerges(),
    loadLaneCommands(),
    loadPreviewMerge(),
    loadLaneRegistry(),
    loadControlPlane(),
    loadReviewHeadIntegrity(),
    loadDag(),
    loadDispatch(),
    loadWorktreeCleanup(),
    loadWorktreeConflicts(),
    loadWorktreeLaunch(),
    loadPostMergeCleanup(),
    loadReview(),
    loadShared(),
  ]);
}

interface MergeOrderCandidate {
  packet: OrchestratorPacket;
  lane: ActivePacketLane;
  worktree: WorktreeInfo;
}

interface OrderedMergeCandidate extends MergeOrderCandidate {
  recommendation: MergeOrderRecommendation;
}

export class HeadShaMismatchError extends Error {
  readonly packetId: string;
  readonly expectedHeadSha: string;
  readonly currentHeadSha: string;

  constructor(packetId: string, expectedHeadSha: string, currentHeadSha: string) {
    super(`Worktree HEAD changed since review for packet ${packetId}: expected ${expectedHeadSha}, current ${currentHeadSha}. Re-review before merging.`);
    this.name = 'HeadShaMismatchError';
    this.packetId = packetId;
    this.expectedHeadSha = expectedHeadSha;
    this.currentHeadSha = currentHeadSha;
  }
}

export function isHeadShaMismatchError(error: unknown): error is HeadShaMismatchError {
  return error instanceof HeadShaMismatchError;
}

function isPacketAwaitingMerge(packet: OrchestratorPacket) {
  return packet.status === 'awaiting_review'
    && packet.releaseState !== 'released'
    && packet.review?.approved !== false;
}

/** Exported for the lane-rebind vitest suite (#1214) — not part of the public API. */
export async function isTerminalReleaseLane(packetId: string) {
  const { getLaneEvents, listLanes } = await loadLaneRegistry();
  return listLanes().some((lane) => {
    if (lane.packetId !== packetId) return false;
    if (lane.status === 'completed') return true;
    if (lane.status !== 'archived') return false;
    // #1214 — archived alone is NOT release evidence: lanes archive after
    // worker death too (e.g. silent_exit_no_work), and a dead lane that kept
    // its packet binding must not short-circuit the recovery lane's merge.
    // Require the lane to have actually passed through 'completed' (only set
    // once a merge landed) before claiming the packet was released.
    return getLaneEvents(lane.id).some((event) =>
      event.verb === 'status_change' && event.payload.status === 'completed'
    );
  });
}

function buildAlreadyReleasedResult(mergeSha: string): MergePacketResult {
  return {
    merged: true,
    note: 'Already released (via auto-merge)',
    alreadyReleased: true,
    mergeSha,
    ancestryVerified: true,
  };
}

function isAlreadyReleasedPacket(packet: OrchestratorPacket | null | undefined) {
  return packet?.releaseState === 'released' || packet?.status === 'released';
}

function recordedMergeSha(packet: OrchestratorPacket | null | undefined) {
  return packet?.releaseStatePayload?.mergeCommit?.trim() || null;
}

async function clearStaleReleaseClaim(packetId: string, reason: string) {
  const { withLockedState } = await loadControlPlane();
  await withLockedState((state) => {
    const packet = state.packets.find((candidate) => candidate.id === packetId);
    if (!packet || !isAlreadyReleasedPacket(packet)) return;
    packet.releaseState = 'pending';
    if (packet.status === 'released') packet.status = 'awaiting_review';
    packet.releaseStatePayload = {
      ...(packet.releaseStatePayload ?? {}),
      source: reason,
    };
  });
}

async function alreadyReleasedResultForPacket(
  packet: OrchestratorPacket | null | undefined,
  lane: ActivePacketLane | null | undefined,
) {
  if (!isAlreadyReleasedPacket(packet)) {
    return null;
  }
  const mergeSha = recordedMergeSha(packet);
  if (mergeSha && lane?.repoPath) {
    const { isAncestorCommit } = await loadMergeTruth();
    if (await isAncestorCommit(lane.repoPath, mergeSha, 'HEAD')) {
      return buildAlreadyReleasedResult(mergeSha);
    }
    console.error('[merge-truth] stale released packet flag; merge SHA is not on main ancestry', {
      packetId: packet?.id,
      mergeSha,
      repoPath: lane.repoPath,
    });
    await clearStaleReleaseClaim(packet!.id, 'stale_release_flag_ancestry_failed');
    return null;
  }
  console.error('[merge-truth] stale released packet flag; no merge SHA available for ancestry verification', {
    packetId: packet?.id,
    repoPath: lane?.repoPath ?? null,
  });
  if (packet?.id) await clearStaleReleaseClaim(packet.id, 'stale_release_flag_missing_merge_sha');
  return null;
}

async function alreadyReleasedResultForPacketId(packetId: string, packets: OrchestratorPacket[]) {
  const { findLatestLaneByPacket, getLaneEvents } = await loadLaneRegistry();
  const lane = findLatestLaneByPacket(packetId);
  const packet = packets.find((candidate) => candidate.id === packetId);
  const packetResult = await alreadyReleasedResultForPacket(packet, lane);
  if (packetResult) return packetResult;
  if (await isTerminalReleaseLane(packetId) && lane?.repoPath) {
    const laneHeadSha = getLaneEvents(lane.id).slice().reverse()
      .map((event) => event.payload.laneHeadSha)
      .find((sha): sha is string => typeof sha === 'string' && sha.trim().length > 0)?.trim();
    if (laneHeadSha) {
      const { isAncestorCommit, readGitHead } = await loadMergeTruth();
      if (await isAncestorCommit(lane.repoPath, laneHeadSha, 'HEAD')) {
        return buildAlreadyReleasedResult(await readGitHead(lane.repoPath));
      }
    }
  }
  return null;
}

async function getWaveMergeOrder(
  state: OrchestratorMissionState,
  packetId: string,
): Promise<OrderedMergeCandidate[] | null> {
  const [
    { buildDependencyGraph },
    { findLatestLaneByPacket },
    { getWorktreeManager },
    { detectFileOverlaps, recommendMergeOrder },
  ] = await Promise.all([
    loadDag(),
    loadLaneRegistry(),
    loadWorktreeLaunch(),
    loadWorktreeConflicts(),
  ]);
  const graph = buildDependencyGraph(state.packets);
  const packetById = new Map(state.packets.map((packet) => [packet.id, packet] as const));
  const targetNode = graph.find((node) => node.packetId === packetId);
  if (!targetNode) {
    return null;
  }

  const targetPacket = packetById.get(packetId);
  const repoPath = state.repoPath ?? targetPacket?.workspaceTargetPath ?? null;
  if (!repoPath) {
    return null;
  }

  const sameWavePackets = graph
    .filter((node) => node.wave === targetNode.wave)
    .map((node) => packetById.get(node.packetId))
    .filter((packet): packet is OrchestratorPacket => packet !== undefined && isPacketAwaitingMerge(packet));

  if (sameWavePackets.length <= 1) {
    return null;
  }

  const worktrees = await getWorktreeManager(repoPath).list();
  const worktreeByPath = new Map(worktrees.map((worktree) => [worktree.path, worktree] as const));
  const candidates = sameWavePackets.flatMap((packet) => {
    const lane = findLatestLaneByPacket(packet.id);
    if (!lane?.worktreePath) {
      return [];
    }

    const worktree = worktreeByPath.get(lane.worktreePath);
    if (!worktree) {
      return [];
    }

    return [{ packet, lane, worktree }];
  });

  if (candidates.length <= 1) {
    return null;
  }

  const candidateWorktrees = candidates.map((candidate) => candidate.worktree);
  const overlaps = detectFileOverlaps(candidateWorktrees);
  const recommendations = await recommendMergeOrder(candidateWorktrees, overlaps);
  const candidateByWorktreeId = new Map(candidates.map((candidate) => [candidate.worktree.id, candidate] as const));

  const ordered = recommendations.flatMap((recommendation) => {
    const candidate = candidateByWorktreeId.get(recommendation.worktreeId);
    return candidate ? [{ ...candidate, recommendation }] : [];
  });

  if (ordered.length <= 1) {
    return null;
  }

  console.log('[merge-order]', {
    wave: targetNode.wave,
    requestedPacketId: packetId,
    sequence: ordered.map(({ packet, worktree, recommendation }) => ({
      position: recommendation.position,
      packetId: packet.id,
      referenceLabel: packet.referenceLabel,
      title: packet.title,
      worktreeId: worktree.id,
      agentType: recommendation.agentType,
      fileCount: recommendation.fileCount,
      totalChanges: recommendation.totalChanges,
      reason: recommendation.reason,
    })),
  });

  return ordered;
}

/**
 * #623 — Decorate a failing merge result with structured gate verdict fields.
 * Populates `checks[]`, `blockers[]`, and the back-compat `reason` string so
 * callers see the same structured shape the preview tool returns.
 * No-op on success results.
 */
async function withGateVerdict(
  packetId: string,
  result: MergePacketResult,
  orchestratorApproved = false,
): Promise<MergePacketResult> {
  if (result.merged) return result;
  // Preserve prior decoration if merge.ts already populated the fields.
  if (result.checks && result.blockers) return result;

  const [{ findLatestLaneByPacket }, { buildPreviewForLane }] = await Promise.all([
    loadLaneRegistry(),
    loadPreviewMerge(),
  ]);
  const lane = findLatestLaneByPacket(packetId);
  if (!lane) return result;

  let preview: MergePreviewResult;
  try {
    preview = await buildPreviewForLane(lane, packetId, { orchestratorApproved });
  } catch (error) {
    console.warn(`${'[mcp-operator]'} gate verdict decoration failed for packet ${packetId}:`, error);
    return result;
  }

  const blockers = preview.blockers;
  const reason = result.reason ?? (blockers.length > 0 ? blockers.join(', ') : result.note);
  return {
    ...result,
    checks: preview.checks,
    blockers,
    reason,
  };
}

async function findLatestMergeApproval(packetId: string, laneId: string, sessionKey?: string | null) {
  const { listApprovalsForContext } = await loadApprovalsStore();
  return listApprovalsForContext({
    packetId,
    laneId,
    sessionKey: sessionKey ?? undefined,
  }).find((approval) => approval.continuation?.kind === 'lane' && approval.continuation.verb === 'merge') ?? null;
}

async function dispatchPacketMerge(
  packet: OrchestratorPacket,
  input: ApproveAndMergeInput,
  actor: 'orchestrator' | 'user',
): Promise<MergePacketResult> {
  const [
    { findLatestLaneByPacket, appendEvent, setLaneStatus },
    { capturePostMergeCleanupTarget, postMergeCleanup },
    { dispatch: dispatchLaneCommand },
    { mapReviewSummary },
    { currentMissionState, log },
    { checkReviewedHeadIntegrity, formatReviewedHeadMismatchNote },
  ] = await Promise.all([
    loadLaneRegistry(),
    loadPostMergeCleanup(),
    loadLaneCommands(),
    loadReview(),
    loadShared(),
    loadReviewHeadIntegrity(),
  ]);
  const alreadyReleased = await alreadyReleasedResultForPacketId(packet.id, currentMissionState().packets);
  if (alreadyReleased) {
    return alreadyReleased;
  }

  const lane = findLatestLaneByPacket(packet.id);
  if (!lane) {
    throw new Error(`Packet ${packet.id} is not bound to an active lane.`);
  }
  let carriedReviewedHeadSha: string | undefined;
  const reviewedHead = await checkReviewedHeadIntegrity(lane, lane.worktreePath || lane.repoPath);
  if (!reviewedHead.ok) {
    const { carryReviewAcrossRebaseIfSamePatch } = await loadReviewCarry();
    const carried = await carryReviewAcrossRebaseIfSamePatch({
      packet,
      lane,
      reviewedHeadSha: reviewedHead.reviewedHeadSha,
      currentHeadSha: reviewedHead.currentHeadSha,
      actor,
    });
    if (carried) {
      carriedReviewedHeadSha = reviewedHead.currentHeadSha;
      log(`Carried review pin across rebase for packet ${packet.id}.`, {
        from: reviewedHead.reviewedHeadSha,
        to: reviewedHead.currentHeadSha,
        actor,
      });
    } else {
      setLaneStatus(lane.id, 'reviewing', 'system', 'review_invalidated');
      appendEvent(lane.id, 'review_invalidated', actor, {
        reviewedHeadSha: reviewedHead.reviewedHeadSha,
        currentHeadSha: reviewedHead.currentHeadSha,
        branch: lane.branch,
        baseBranch: lane.baseBranch,
        packetId: lane.packetId,
      });
      return {
        merged: false,
        note: formatReviewedHeadMismatchNote(reviewedHead),
        reason: 'head_moved_since_review',
        reviewedHeadSha: reviewedHead.reviewedHeadSha,
        currentHeadSha: reviewedHead.currentHeadSha,
      };
    }
  }
  const cleanupTarget = await capturePostMergeCleanupTarget(lane);

  const result = await dispatchLaneCommand({
    verb: 'merge',
    laneId: lane.id,
    commitMessage: input.commitMessage?.trim() || undefined,
    reviewSummary: mapReviewSummary(packet),
    // Advisory only; commands.ts re-derives authorization from durable review rows.
    orchestratorReviewed: packet.review?.approved === true,
    expectedHeadSha: input.expectedHeadSha?.trim() || carriedReviewedHeadSha || packet.review?.reviewedHeadSha?.trim() || undefined,
    actor,
  });

  if (!result.ok && result.reason === 'head_moved_since_review' && result.reviewedHeadSha && result.currentHeadSha) {
    const { carryReviewAcrossRebaseIfSamePatch } = await loadReviewCarry();
    const carried = await carryReviewAcrossRebaseIfSamePatch({
      packet,
      lane,
      reviewedHeadSha: result.reviewedHeadSha,
      currentHeadSha: result.currentHeadSha,
      actor,
    });
    if (carried) {
      return dispatchPacketMerge(packet, input, actor);
    }
    log(`Merge refused for packet ${packet.id}: reviewed HEAD moved.`, {
      reviewedHeadSha: result.reviewedHeadSha,
      currentHeadSha: result.currentHeadSha,
      actor,
    });
    return {
      merged: false,
      note: result.note,
      reason: 'head_moved_since_review',
      reviewedHeadSha: result.reviewedHeadSha,
      currentHeadSha: result.currentHeadSha,
    };
  }

  if (!result.ok && result.expectedHeadSha && result.currentHeadSha) {
    throw new HeadShaMismatchError(packet.id, result.expectedHeadSha, result.currentHeadSha);
  }

  // #622 — Synchronous worktree cleanup guarantee.
  if (result.ok) {
    // #1110 follow-up — stamp mergedClean on the session_outcomes row so the
    // routing recommender (#747) can score successful merges. Fire-and-forget:
    // a ledger update failure must NEVER roll back a successful merge.
    void import('@/lib/orchestrator/context-relay').then(({ markOutcomeMerged }) =>
      markOutcomeMerged({ laneId: lane.id, packetId: packet.id }),
    ).catch((err) => {
      console.warn(`[session-outcome-merge] mergedClean backfill failed for packet ${packet.id}:`, err);
    });

    const [{ removeMergedWorktree }, { appendDirectiveTrailer }] = await Promise.all([
      loadWorktreeCleanup(),
      loadDirectiveMerges(),
    ]);
    const cleanup = await removeMergedWorktree(lane);
    if (!cleanup.removed) {
      console.log(
        '[worktree-cleanup]',
        `Post-merge cleanup skipped for lane ${lane.id} (packet ${packet.id}): reason=${cleanup.reason ?? 'unknown'}. Reconcile sweep will handle it.`,
      );
    }
    void postMergeCleanup(cleanupTarget).catch((error) => {
      console.warn(`[merge-cleanup] Unexpected cleanup failure for lane ${lane.id}:`, error);
    });

    // #769 — Living Specs. Append a one-line trailer to every directive
    // matching this repo so each directive accumulates evidence of which
    // merges respected (or, once #732 ships violation flags, violated)
    // it. Best-effort — never roll back a successful merge over a markdown
    // bug. `violated` is wired off `packet.review.approved === false`,
    // matching the same flag that gates `[REJECTED]` in the outcomes block.
    try {
      const repoPath = packet.workspaceTargetPath?.trim() || lane.repoPath;
      if (repoPath) {
        const violated = packet.review?.approved === false;
        const updated = appendDirectiveTrailer({
          repoPath,
          entry: {
            date: new Date().toISOString().slice(0, 10),
            status: violated ? 'violated' : 'merged',
            title: packet.title,
            issueNumber: packet.issue?.number ?? null,
          },
          // #843 — Pass the merge commit message through so any
          // `Spec-Update: <directive-name>` lines in the body narrow the
          // trailer to a specific directive instead of blanket-appending.
          commitMessage: input.commitMessage ?? null,
        });
        if (updated.length > 0) {
          console.log(
            `[living-specs] Appended ${violated ? '[violated]' : '[merged]'} trailer to ${updated.length} directive${updated.length === 1 ? '' : 's'} for packet ${packet.id} (${updated.join(', ')})`,
          );
          // #840 — `appendDirectiveTrailer` itself fires
          // `publishCortexChange({ scope: 'directive' })` so any caller
          // (this path + REPL smoke tests + future external-merge handler)
          // refreshes the Recall Card without extra wiring here.
        }
      }
    } catch (error) {
      console.warn(
        `[living-specs] Trailer append failed for packet ${packet.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  // Sync first so reconciliation runs, then apply the release on top.
  // This prevents reconciliation from resetting the packet status after we set it.
  // Pass undefined so sync re-reads inside the mutex — otherwise we race the
  // /api/orchestrator/state GET poll and other concurrent writers.
  const [
    { syncOrchestratorControlPlaneState, writeOrchestratorControlPlaneState },
    { runDispatchTick },
  ] = await Promise.all([
    loadControlPlane(),
    loadDispatch(),
  ]);
  const synced = await syncOrchestratorControlPlaneState();

  const releasedAfterDispatch = await alreadyReleasedResultForPacketId(input.packetId, synced.packets);
  if (!result.ok && releasedAfterDispatch) {
    return releasedAfterDispatch;
  }

  if (result.ok) {
    for (const packetState of synced.packets) {
      if (packetState.id === input.packetId) {
        packetState.status = 'released';
        packetState.queueState = 'held';
        packetState.releaseState = 'released';
        packetState.releaseStatePayload = {
          ...(packetState.releaseStatePayload ?? {}),
          mergeCommit: result.mergeSha ?? null,
          releasedAt: new Date().toISOString(),
          source: 'approve_and_merge',
        };
        packetState.blockedReason = null;
        if (packetState.lane) {
          packetState.lane.lastEventLabel = 'merged';
        }
        break;
      }
    }
  }

  const afterDispatch = await runDispatchTick(synced);
  writeOrchestratorControlPlaneState(afterDispatch);
  if (result.ok) autoResolveMergedPacketVerificationIncidents({ packetId: packet.id, laneId: lane.id, event: 'approve_and_merge' });

  // #1492 — auto buy-in doc. Fire-and-forget so it NEVER blocks or fails a
  // merge; the packet carries a generating→ready|failed status and the released
  // card only surfaces a link when ready. Off by default (operator opt-in).
  if (result.ok) {
    try {
      const { resolveBuyinDocEnabledSync } = await import('@/lib/operator/defaults');
      const { shouldGenerateBuyinDoc, generateBuyinDoc } = await import('@/lib/lane/buyin-doc');
      if (shouldGenerateBuyinDoc({ enabled: resolveBuyinDocEnabledSync(), mergeOk: result.ok, packetId: packet.id })) {
        const { listArtifacts, artifactAbsPath } = await import('@/lib/artifacts/store');
        const demoArtifacts = listArtifacts({ packetId: packet.id })
          .filter((a) => a.kind === 'screenshot' || a.kind === 'video')
          .map((a) => ({
            absPath: artifactAbsPath(a.relPath),
            label: a.label,
            phase: a.phase,
            kind: a.kind,
            mimeType: a.mimeType,
          }));
        void generateBuyinDoc({
          repoPath: lane.repoPath,
          laneId: lane.id,
          packetId: packet.id,
          packetTitle: packet.title,
          packetSummary: packet.summary ?? '',
          mergeSha: result.mergeSha ?? null,
          deviationsRaw: packet.deviations?.raw ?? null,
          demoArtifacts,
        }).catch((error) => {
          console.warn(`[buyin-doc] Generation threw for packet ${packet.id}:`, error);
        });
      }
    } catch (error) {
      console.warn(`[buyin-doc] Failed to launch generation for packet ${packet.id}:`, error);
    }
  }

  log(`Merge command finished for packet ${packet.id}.`, {
    ok: result.ok,
    approvalId: result.approvalId ?? null,
    actor,
  });

  return withGateVerdict(packet.id, {
    merged: result.ok,
    note: result.note,
    ...(result.mergeSha ? { mergeSha: result.mergeSha } : {}),
    ...(result.approvalId ? { approvalId: result.approvalId } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.reviewedHeadSha ? { reviewedHeadSha: result.reviewedHeadSha } : {}),
    ...(result.currentHeadSha ? { currentHeadSha: result.currentHeadSha } : {}),
  }, packet.review?.approved === true);
}

async function approveAndMergeSinglePacket(input: ApproveAndMergeInput): Promise<MergePacketResult> {
  const { currentMissionState } = await loadShared();
  const state = currentMissionState();
  const packet = state.packets.find((candidate) => candidate.id === input.packetId);
  const alreadyReleased = await alreadyReleasedResultForPacketId(input.packetId, state.packets);
  if (alreadyReleased) {
    return alreadyReleased;
  }

  if (!packet) {
    // #557 — Fall through to lane-only merge when the mission packet is missing.
    // #622 — wrapper captures lane pre-merge and runs synchronous cleanup on
    // success, making the bash-merge fallback atomic with the merge commit.
    const { mergeOrphanLaneByPacket } = await import('../orphan-lane-merge');
    const { withSynchronousWorktreeCleanup } = await loadWorktreeCleanup();
    const orphanResult = await withSynchronousWorktreeCleanup(
      input.packetId,
      () => mergeOrphanLaneByPacket(input.packetId, input.commitMessage, input.expectedHeadSha),
    );
    const releasedAfterOrphanDispatch = await alreadyReleasedResultForPacketId(input.packetId, currentMissionState().packets);
    if (!orphanResult.merged && releasedAfterOrphanDispatch) {
      return releasedAfterOrphanDispatch;
    }
    if (!orphanResult.merged && orphanResult.expectedHeadSha && orphanResult.currentHeadSha) {
      throw new HeadShaMismatchError(input.packetId, orphanResult.expectedHeadSha, orphanResult.currentHeadSha);
    }
    if (!orphanResult.merged && orphanResult.reason === 'head_moved_since_review') {
      return orphanResult;
    }
    return withGateVerdict(input.packetId, orphanResult);
  }

  if (packet.review && !packet.review.approved) {
    return {
      merged: false,
      note: 'Packet review is not approved. Resolve findings before merging.',
    };
  }

  const { findLatestLaneByPacket } = await loadLaneRegistry();
  const lane = findLatestLaneByPacket(packet.id);
  if (!lane) {
    throw new Error(`Packet ${packet.id} is not bound to an active lane.`);
  }
  const latestMergeApproval = await findLatestMergeApproval(packet.id, lane.id, lane.sessionKey);
  if (latestMergeApproval?.status === 'pending') {
    // A live human operator clicking merge IS the approval — resolve the
    // pending card (full audit trail) and fall through to the merge instead
    // of bouncing the human to the inbox for a second click (Q ruling
    // 2026-07-18). Gate violations stay a hard stop even for the operator:
    // that card carries findings a human must actually read.
    if (input.actor === 'user' && latestMergeApproval.policyRuleId !== 'merge-gate-violation') {
      const { resolveApproval } = await import('@/lib/approvals/store');
      resolveApproval(latestMergeApproval.id, 'approve', 'desktop', 'Operator merged directly from the review surface.');
    } else {
      return withGateVerdict(packet.id, {
        merged: false,
        note: latestMergeApproval.policyRuleId === 'merge-gate-violation'
          ? 'Merge gate enforcement: human review required.'
          : `Approval required: ${latestMergeApproval.title}`,
        approvalId: latestMergeApproval.id,
      }, packet.review?.approved === true);
    }
  }
  if (latestMergeApproval?.status === 'approved' && (lane.status === 'completed' || lane.status === 'archived')) {
    const { syncOrchestratorControlPlaneState } = await loadControlPlane();
    const synced = await syncOrchestratorControlPlaneState();
    const releasedAfterSync = await alreadyReleasedResultForPacketId(packet.id, synced.packets);
    if (releasedAfterSync) return releasedAfterSync;
  }

  const mergeActor = latestMergeApproval?.status === 'approved' ? 'user' : 'orchestrator';
  return dispatchPacketMerge(packet, input, mergeActor);
}

export async function approveAndMergePacket(input: ApproveAndMergeInput) {
  const { currentMissionState } = await loadShared();
  const state = currentMissionState();
  const packet = state.packets.find((candidate) => candidate.id === input.packetId);
  // #557 — Missing packet falls through to single-packet merge (lane fallback).
  if (!packet) return approveAndMergeSinglePacket(input);

  const orderedWavePackets = await getWaveMergeOrder(state, packet.id);
  if (!orderedWavePackets) {
    return approveAndMergeSinglePacket(input);
  }

  const targetIndex = orderedWavePackets.findIndex((candidate) => candidate.packet.id === packet.id);
  if (targetIndex === -1) {
    return approveAndMergeSinglePacket(input);
  }

  const mergeSequence = orderedWavePackets.slice(0, targetIndex + 1);
  const mergedPrerequisites: string[] = [];
  let requestedResult: MergePacketResult | null = null;

  for (const candidate of mergeSequence) {
    const result = await approveAndMergeSinglePacket({
      packetId: candidate.packet.id,
      commitMessage: candidate.packet.id === packet.id ? input.commitMessage : undefined,
      expectedHeadSha: candidate.packet.id === packet.id ? input.expectedHeadSha : undefined,
    });

    if (!result.merged) {
      return {
        merged: false,
        note: candidate.packet.id === packet.id
          ? result.note
          : `Merge order requires ${candidate.packet.referenceLabel} to merge before ${packet.referenceLabel}: ${result.note}`,
        ...(result.approvalId ? { approvalId: result.approvalId } : {}),
        ...(result.checks ? { checks: result.checks } : {}),
        ...(result.blockers ? { blockers: result.blockers } : {}),
        ...(result.reason ? { reason: result.reason } : result.blockers ? { reason: result.blockers.join(', ') || result.note } : {}),
        ...(result.reviewedHeadSha ? { reviewedHeadSha: result.reviewedHeadSha } : {}),
        ...(result.currentHeadSha ? { currentHeadSha: result.currentHeadSha } : {}),
      };
    }

    if (candidate.packet.id !== packet.id) {
      mergedPrerequisites.push(candidate.packet.referenceLabel);
      continue;
    }

    requestedResult = result;
  }

  if (!requestedResult) {
    return {
      merged: false,
      note: `Packet ${packet.referenceLabel} was not included in the recommended merge sequence.`,
    };
  }

  return {
    merged: true,
    note: mergedPrerequisites.length > 0
      ? `Merged ${mergedPrerequisites.join(', ')} before ${packet.referenceLabel} based on recommended same-wave merge order. ${requestedResult.note}`
      : requestedResult.note,
  };
}

export async function pickComparisonWinner(input: PickComparisonWinnerInput) {
  const [
    { currentMissionState },
    { withLockedState },
    { archiveLane },
    { submitPacketReview },
    { recordLaneEvent },
  ] = await Promise.all([
    loadShared(),
    loadControlPlane(),
    loadLaneRegistry(),
    loadReview(),
    loadLaneEvents(),
  ]);
  const state = currentMissionState();
  const winner = state.packets.find((candidate) => candidate.id === input.packetId);
  if (!winner) {
    throw new Error(`Packet ${input.packetId} not found.`);
  }

  const comparisonGroupId = winner.comparisonGroupId?.trim();
  if (!comparisonGroupId) {
    throw new Error(`Packet ${winner.id} is not part of a comparison group.`);
  }

  const comparisonPackets = state.packets.filter((packet) => packet.comparisonGroupId === comparisonGroupId);
  if (comparisonPackets.length < 2) {
    throw new Error(`Comparison group ${comparisonGroupId} has no alternate candidates to compare.`);
  }

  const archivedPacketIds = comparisonPackets
    .filter((packet) => packet.id !== winner.id)
    .map((packet) => packet.id);
  const archivedAt = new Date().toISOString();

  await withLockedState(async (current) => {
    const activeComparisonGroups = new Set(current.activeComparisonGroups ?? []);
    activeComparisonGroups.delete(comparisonGroupId);
    current.activeComparisonGroups = [...activeComparisonGroups];

    for (const packet of current.packets) {
      if (packet.comparisonGroupId !== comparisonGroupId) {
        continue;
      }

      if (packet.id === winner.id) {
        packet.lastEventAt = archivedAt;
        packet.lastEventLabel = 'comparison_winner_selected';
        if (packet.lane) {
          packet.lane.lastEventAt = archivedAt;
          packet.lane.lastEventLabel = 'comparison_winner_selected';
        }
        continue;
      }

      packet.archivedAt = archivedAt;
      packet.status = 'archived';
      packet.queueState = 'held';
      packet.blockedReason = null;
      packet.lastEventAt = archivedAt;
      packet.lastEventLabel = 'comparison_loser_archived';
      if (packet.lane) {
        packet.lane.lastEventAt = archivedAt;
        packet.lane.lastEventLabel = 'comparison_loser_archived';
      }

      if (packet.lane?.laneId) {
        archiveLane(packet.lane.laneId, 'user');
      }
    }
  });
  for (const packetId of archivedPacketIds) {
    autoResolveMergedPacketVerificationIncidents({ packetId, event: 'comparison_loser_archived' });
  }

  // Gap A (governance): record the operator's pick as an APPROVING review BEFORE
  // the merge, so the gate sees a HEAD-matched review instead of falling through to
  // risk-tier and stalling on a pending "human review required". submitPacketReview
  // captures the winner's current HEAD itself. Best-effort: a failed record must not
  // swallow the merge attempt (the gate still surfaces any real blocker).
  try {
    await submitPacketReview({ packetId: winner.id, findings: [], approved: true });
  } catch (error) {
    console.error('[comparison-pick] winner review record failed:', error);
  }

  // Gap B (audit): the pick is a first-class, governed decision — record it on the
  // winner's lane so the ledger answers "why W over X, Y" (parity with browser_acted).
  if (winner.lane?.laneId) {
    try {
      recordLaneEvent(winner.lane.laneId, 'comparison_resolved', 'user', {
        groupId: comparisonGroupId,
        winnerPacketId: winner.id,
        archivedPacketIds,
      });
    } catch (error) {
      console.error('[comparison-pick] comparison_resolved event failed:', error);
    }
  }

  const mergeResult = await approveAndMergePacket({
    packetId: winner.id,
    commitMessage: input.commitMessage,
  });

  return {
    ...mergeResult,
    groupId: comparisonGroupId,
    archivedPacketIds,
  };
}
