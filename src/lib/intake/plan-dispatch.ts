/**
 * Plan Dispatch
 *
 * When an operator approves a plan approval, this module creates orchestrator
 * packets from the plan's tasks and writes them to the control plane.
 * The headless loop then dispatches Codex agents for each packet.
 */

import 'server-only';

import { randomUUID } from 'node:crypto';
import type { PlanApprovalContinuation } from '@/lib/approvals/types';
import type { OrchestratorPacket, OrchestratorRuntime } from '@/lib/orchestrator/types';

const LOG_PREFIX = '[plan-dispatch]';

function buildPacketFromTask(
  task: { title: string; body: string },
  index: number,
  repoPath: string,
  runtime: OrchestratorRuntime,
  issueNumber: number,
): OrchestratorPacket {
  const now = new Date().toISOString();
  return {
    id: `pkt-${randomUUID()}`,
    referenceLabel: `P${index + 1}`,
    title: `#${issueNumber}: ${task.title}`,
    summary: task.body,
    workspaceTargetPath: repoPath,
    branchTarget: '',
    runtime,
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    attemptCount: 0,
    maxAttempts: 3,
    blockedReason: null,
    lastEventAt: now,
    lastEventLabel: 'plan_approved',
    archivedAt: null,
    review: null,
    lane: null,
    dispatchRuntimePin: runtime,
  };
}

export async function dispatchApprovedPlan(
  plan: PlanApprovalContinuation,
): Promise<{ ok: boolean; missionId: string; packetCount: number; note: string }> {
  const { withLockedState } = await import('@/lib/orchestrator/control-plane');
  const { runHeadlessSprintTick } = await import('@/lib/orchestrator/headless-loop');

  const packets = plan.tasks.map((task, index) =>
    buildPacketFromTask(task, index, plan.repoPath, plan.runtime, plan.issueNumber),
  );

  const missionId = `intake-${plan.issueNumber}-${Date.now().toString(36)}`;
  console.log(`${LOG_PREFIX} Creating mission ${missionId} with ${packets.length} packet(s) for issue #${plan.issueNumber}`);

  // Read-modify-write under the control-plane lock (#460) — a raw write here
  // races the headless loop and concurrent approvals (last writer wins,
  // silently dropping packets).
  const { state } = await withLockedState((current) => {
    // If there's an active mission with running packets, append. Otherwise fresh.
    const hasActivePackets = current.packets.some((p) =>
      p.status === 'running' || p.status === 'launching' || p.status === 'queued',
    );

    return {
      ...current,
      version: 2,
      missionId: hasActivePackets ? current.missionId : missionId,
      prompt: hasActivePackets
        ? current.prompt
        : `GitHub intake: issue #${plan.issueNumber} — ${plan.issueTitle}`,
      summary: hasActivePackets
        ? current.summary
        : `Intake mission for #${plan.issueNumber}: ${plan.issueTitle}`,
      repoPath: plan.repoPath,
      runtime: plan.runtime,
      constraints: plan.constraints || current.constraints || '',
      packets: hasActivePackets
        ? [...current.packets, ...packets]
        : packets,
      updatedAt: new Date().toISOString(),
    };
  });
  const committedMissionId = state.missionId || missionId;

  // Trigger the headless loop to pick up the new packets
  void runHeadlessSprintTick().catch((error) => {
    console.error(`${LOG_PREFIX} Headless tick failed after plan dispatch: ${error instanceof Error ? error.message : String(error)}`);
  });

  const note = `Dispatched ${packets.length} packet${packets.length === 1 ? '' : 's'} for issue #${plan.issueNumber}.`;
  console.log(`${LOG_PREFIX} ${note}`);
  return { ok: true, missionId: committedMissionId, packetCount: packets.length, note };
}
