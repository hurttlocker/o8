import type { ApprovalGateResult } from '@/lib/approvals/types';
import { supersedeDurableApprovedReviews } from '@/lib/lane/durable-review-approval';
import { buildCheckList } from '@/lib/lane/preview-merge';
import {
  appendEvent,
  countLaneEventsByVerbSinceLastLaunch,
  setLaneStatus,
} from '@/lib/lane/registry';
import type { LaneRebaseVerifyResult } from '@/lib/lane/rebase-verify';
import type { Lane, LaneCommand, LaneCommandResult, LaneEventActor } from '@/lib/lane/types';
import type { MergePacketResult } from '@/lib/orchestrator/operator-mission-service/types';

const VERIFY_FEEDBACK_MAX_BYTES = 4 * 1024;

type MergeCommand = Extract<LaneCommand, { verb: 'merge' }>;
type VerifyFailure = Extract<LaneRebaseVerifyResult, { ok: false }>;

interface PostRebaseVerifyFailureInput {
  lane: Lane;
  command: MergeCommand;
  actor: LaneEventActor;
  gateResult: ApprovalGateResult;
}

export function mergePacketResultFromLaneCommand(result: LaneCommandResult): MergePacketResult {
  return {
    merged: result.ok,
    note: result.note,
    ...(result.mergeSha ? { mergeSha: result.mergeSha } : {}),
    ...(result.approvalId ? { approvalId: result.approvalId } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.checks ? { checks: result.checks } : {}),
    ...(result.blockers ? { blockers: result.blockers } : {}),
    ...(result.expectedHeadSha ? { expectedHeadSha: result.expectedHeadSha } : {}),
    ...(result.reviewedHeadSha ? { reviewedHeadSha: result.reviewedHeadSha } : {}),
    ...(result.currentHeadSha ? { currentHeadSha: result.currentHeadSha } : {}),
  };
}

function truncateForBlocker(output: string): string {
  if (output.length <= VERIFY_FEEDBACK_MAX_BYTES) return output;
  return `${output.slice(0, VERIFY_FEEDBACK_MAX_BYTES)}\n\n[truncated — full output in lane_events]`;
}

function verificationLabel(kind: VerifyFailure['kind']): string {
  if (kind === 'tests') return 'Tests';
  return kind === 'lint' ? 'Lint' : 'Typecheck';
}

function formatVerificationFeedback(lane: Lane, failure: VerifyFailure): string {
  const label = verificationLabel(failure.kind);
  return [
    `Post-rebase ${label.toLowerCase()} failed after rebasing ${lane.branch} onto ${lane.baseBranch}.`,
    `Fix the ${label.toLowerCase()} errors below, then commit so the operator can re-attempt the merge.`,
    '',
    truncateForBlocker(failure.output),
  ].join('\n');
}

/** Read the packet-scoped retry budget, falling back to lane events when absent. */
async function readPacketTypecheckRetries(packetId: string | null | undefined): Promise<number | null> {
  if (!packetId) return null;
  try {
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const packet = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packetId);
    return packet ? (packet.typecheckAutoRetries ?? 0) : null;
  } catch {
    return null;
  }
}

/** Feed every post-rebase verification failure through the existing bounded retry chain. */
export async function handlePostRebaseVerifyFailure(
  input: PostRebaseVerifyFailureInput,
  failure: VerifyFailure,
): Promise<LaneCommandResult> {
  const { lane, command, actor } = input;
  const truncatedOutput = truncateForBlocker(failure.output);
  const checks = buildCheckList(input.gateResult, failure.checks);
  const blockers = [failure.kind];
  const label = verificationLabel(failure.kind);
  const priorAutoRetries = (await readPacketTypecheckRetries(lane.packetId))
    ?? countLaneEventsByVerbSinceLastLaunch(command.laneId, 'typecheck_auto_retry');

  if (priorAutoRetries >= 1 || !lane.packetId) {
    const escalationReason = priorAutoRetries >= 1 ? 'retry_exhausted' : 'no_packet';
    const blockedReason = !lane.packetId
      ? `${label} failed after rebase onto ${lane.baseBranch}. No packetId on lane, cannot auto-rerun. Orchestrator decision needed (steer / redispatch / abandon).\n\n${truncatedOutput}`
      : `${label} failed after 1 auto-retry. Orchestrator decision needed (steer / redispatch / abandon).\n\n${truncatedOutput}`;
    appendEvent(command.laneId, 'typecheck_escalation', 'system', {
      kind: failure.kind,
      reason: escalationReason,
      priorAutoRetries,
      branch: lane.branch,
      baseBranch: lane.baseBranch,
      packetId: lane.packetId,
      output: truncatedOutput,
    });
    setLaneStatus(command.laneId, 'awaiting_orchestrator', 'system', `typecheck_escalated:${escalationReason}`);
    return { ok: false, laneId: command.laneId, note: blockedReason, checks, blockers };
  }

  appendEvent(command.laneId, 'typecheck_auto_retry', 'system', {
    kind: failure.kind,
    branch: lane.branch,
    baseBranch: lane.baseBranch,
    packetId: lane.packetId,
    output: truncatedOutput,
  });
  setLaneStatus(command.laneId, 'reviewing', actor, 'typecheck_auto_retry');
  await supersedeDurableApprovedReviews(
    lane.packetId,
    failure.kind === 'typecheck'
      ? 'Superseded by typecheck auto-rerun.'
      : `Superseded by post-rebase ${label.toLowerCase()} auto-rerun.`,
  );

  try {
    const { withLockedState } = await import('@/lib/orchestrator/control-plane');
    await withLockedState((current) => {
      const packet = current.packets.find((candidate) => candidate.id === lane.packetId);
      if (packet) packet.typecheckAutoRetries = (packet.typecheckAutoRetries ?? 0) + 1;
    });
  } catch (error) {
    console.warn(
      `[lane-merge] Could not persist typecheck retry budget for packet ${lane.packetId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const feedback = formatVerificationFeedback(lane, failure);
  void (async () => {
    try {
      const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
      const currentPacket = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === lane.packetId);
      if (!currentPacket || currentPacket.queueState === 'held') {
        console.log(
          `[lane-merge] Skipping auto-rerun for packet ${lane.packetId} — ${currentPacket ? 'packet is held (reset_packet)' : 'packet no longer exists'} (#1257).`,
        );
        return;
      }
      const { rerunWithFeedback } = await import('@/lib/orchestrator/operator-mission-service');
      await rerunWithFeedback({ packetId: lane.packetId!, feedback });
      console.log(
        `[lane-merge] Auto-rerun dispatched for packet ${lane.packetId} after ${label.toLowerCase()} failure on lane ${command.laneId}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[lane-merge] Auto-rerun failed for packet ${lane.packetId} on lane ${command.laneId}: ${message}`,
      );
      appendEvent(command.laneId, 'typecheck_escalation', 'system', {
        kind: failure.kind,
        reason: 'rerun_dispatch_failed',
        priorAutoRetries: priorAutoRetries + 1,
        branch: lane.branch,
        baseBranch: lane.baseBranch,
        packetId: lane.packetId,
        output: truncatedOutput,
        dispatchError: message,
      });
      setLaneStatus(command.laneId, 'awaiting_orchestrator', 'system', 'typecheck_rerun_failed');
    }
  })();

  return {
    ok: false,
    laneId: command.laneId,
    note: `${label} failed after rebase onto ${lane.baseBranch}. Auto-rerun dispatched with the ${label.toLowerCase()} output as feedback; the packet will retry in a fresh worktree.\n\n${truncatedOutput}`,
    reason: 'typecheck_auto_retry',
    checks,
    blockers,
  };
}
