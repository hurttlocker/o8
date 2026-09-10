import { randomUUID } from 'node:crypto';
import { updateLane } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { fetchRuntimeAction } from '@/lib/ws-server/next-fetch';
import { recordSelfReviewInterruptFailure } from '@/lib/ws-server/self-review-transition';
import type { AgentUpdateEvent } from './agent-supervisor-types';
import { createCompletionTurnGuard, SupersededCompletionError } from './completion-turn';
import { runCompletionVerification } from './completion-verification';
import { hasFreshSelfReviewTranscriptActivity, preserveSelfReviewStallWork,
  resetSelfReviewStallGuard, type SelfReviewStallDecision } from './self-review-stall-guard';

interface ForceReviewDependencies {
  park(surfaceId: string, lane: Lane, reason: string, captureRef?: string, checkCurrent?: () => void): Promise<void>;
  unregister(surfaceId: string): void;
  enqueueAutoReview(laneId: string): Promise<unknown>;
  triggerHeadlessSprintTick(): Promise<unknown>;
  queueReviewContinuation(lane: Lane): void;
  broadcastUpdate(event: AgentUpdateEvent): void;
  escalate(repoPath: string, message: string): void;
}

/** The server's forced-review path preserves work, but never creates a merge receipt. */
export async function forceSelfReviewToReview(
  surfaceId: string,
  lane: Lane,
  decision: Extract<SelfReviewStallDecision, { kind: 'force-review' }>,
  dependencies: ForceReviewDependencies,
): Promise<void> {
  const guard = createCompletionTurnGuard(lane, { allowRuntimeExit: true });
  const cwd = decision.cwd || lane.worktreePath || lane.repoPath;
  try {
    const preservation = await guard.wait(() => preserveSelfReviewStallWork(lane, cwd));
    if (await guard.wait(() => hasFreshSelfReviewTranscriptActivity(surfaceId))) {
      resetSelfReviewStallGuard(surfaceId);
      return;
    }
    if (preservation.error || !preservation.hasReviewableDiff) {
      await dependencies.park(surfaceId, lane, preservation.error
        ? `Auto-commit failed: ${preservation.error}`
        : 'No reviewable commit remained after preserving the worktree.', preservation.captureRef, guard.check);
      return;
    }
    const verification = await guard.wait(() => runCompletionVerification(cwd, lane.baseBranch));
    if (await guard.wait(() => hasFreshSelfReviewTranscriptActivity(surfaceId))) {
      resetSelfReviewStallGuard(surfaceId);
      return;
    }
    if (!verification.ok) {
      await dependencies.park(surfaceId, lane,
        `Preserved work failed ${verification.kind}; operator review is required.`, preservation.captureRef, guard.check);
      return;
    }
    if (lane.packetId) {
      try {
        const { capturePacketCompletionContext } = await guard.wait(() => import('@/lib/orchestrator/context-relay'));
        await guard.wait(() => capturePacketCompletionContext(lane.packetId!, surfaceId));
      } catch (error) {
        guard.check();
        console.error(`[context-relay] Failed to capture self-review context for packet ${lane.packetId}:`, error);
      }
    }
    try {
      await guard.wait(() => fetchRuntimeAction({ action: 'interrupt', surfaceId, clientMutationId: randomUUID() }));
    } catch (error) {
      guard.check();
      const reason = recordSelfReviewInterruptFailure({ laneId: lane.id, surfaceId, error });
      resetSelfReviewStallGuard(surfaceId);
      const detail = `Self-review work was preserved, but interrupt did not confirm a stop: ${reason}`;
      dependencies.broadcastUpdate({ surfaceId, name: lane.label, status: 'stuck', detail, repoPath: lane.repoPath });
      dependencies.escalate(lane.repoPath, [
        `[SUPERVISOR] Agent "${lane.label}" (${surfaceId}) could not be stopped after its work was preserved.`,
        `Lane: ${lane.id}`, `Reason: ${reason}`, '',
        'The runtime remains bound and the lane remains active. Confirm the stop before moving this work to review.',
      ].join('\n'));
      return;
    }
    guard.check();
    dependencies.unregister(surfaceId);
    const updated = updateLane(lane.id, { status: 'reviewing', sessionKey: null,
      lastEventAt: new Date().toISOString(), lastEventLabel: 'self_review_stall_forced' }, 'system');
    if (!updated) return;
    const reviewGuard = createCompletionTurnGuard(updated);
    await reviewGuard.wait(() => dependencies.enqueueAutoReview(updated.id));
    await reviewGuard.wait(() => dependencies.triggerHeadlessSprintTick());
    dependencies.queueReviewContinuation(updated);
    resetSelfReviewStallGuard(surfaceId);
    dependencies.broadcastUpdate({ surfaceId, name: lane.label, status: 'completed',
      detail: preservation.committed
        ? 'Self-review stalled after verification; worktree was committed and moved to review.'
        : 'Self-review stalled after verification; existing commit was moved to review.', repoPath: lane.repoPath });
  } catch (error) {
    if (!(error instanceof SupersededCompletionError)) throw error;
    resetSelfReviewStallGuard(surfaceId);
  }
}
