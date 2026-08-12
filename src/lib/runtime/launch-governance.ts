import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { isOwnedOrchestratorSessionKey, ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import { summarizeTaskName } from '@/lib/runtime/project-launch-brief';
import { escalateInterruptOwnedSurface } from '@/lib/runtime/interrupt-escalation';
import { confirmDiscoveredInterrupt } from '@/lib/runtime/confirmed-interrupt';
import { archiveOwnedRuntimeSession } from '@/lib/runtime/owned-session-archive';
import { linkSessionToWorktree } from '@/lib/worktree';
import { WorktreeManager } from '@/lib/worktree/manager';
import type { AgentRuntime, RuntimeActionResult } from '@/lib/runtimes/types';
import type { RuntimeLaunchRequest, RuntimeLaunchResult } from '@/lib/runtime/actions';

/** A provider session exists, but its local governance registration did not settle. */
export class RuntimeLaunchPostEffectError extends Error {
  constructor(readonly result: RuntimeLaunchResult, cause?: unknown) {
    super(result.note, { cause });
    this.name = 'RuntimeLaunchPostEffectError';
  }
}

export async function settleRuntimeLaunchGovernance(input: {
  payload: RuntimeLaunchRequest;
  runtime: AgentRuntime;
  runtimeId: string;
  prompt: string;
  result: RuntimeActionResult;
  launchWorktree: Awaited<ReturnType<typeof import('@/lib/worktree').prepareLaunchWorktree>>;
  projectId: string | null;
  cwd: string;
  repoPath: string;
}): Promise<RuntimeLaunchResult> {
  const { payload, runtime, runtimeId, prompt, result, launchWorktree, projectId, cwd, repoPath } = input;
  if (!result.sessionKey) throw new Error(result.note || `Unable to launch ${runtimeId}.`);
  if (!result.ok) {
    return {
      ok: false,
      runtime: runtimeId,
      clientMutationId: payload.clientMutationId,
      surfaceId: result.sessionKey,
      note: result.note || `The ${runtimeId} launch failed after creating its session record.`,
      cwd,
      repoPath,
      worktree: launchWorktree?.worktree ?? null,
      laneId: payload.existingLaneId ?? null,
    };
  }

  try {
    if (launchWorktree?.worktree) {
      await linkSessionToWorktree(repoPath, launchWorktree.worktree.id, result.sessionKey);
    }
    let laneId: string | null = payload.existingLaneId ?? null;
    const laneRuntime: OrchestratorRuntime | null = ORCHESTRATOR_RUNTIMES[runtimeId as OrchestratorRuntime]
      ? runtimeId as OrchestratorRuntime
      : null;
    if (!laneId && launchWorktree?.worktree && laneRuntime) {
      let createdLaneId: string | null = null;
      try {
        const { createLane, attachSession } = await import('@/lib/lane/registry');
        const lane = createLane({
          repoPath,
          projectId,
          branch: launchWorktree.worktree.branch,
          baseBranch: payload.baseBranch?.trim() || 'main',
          runtime: laneRuntime,
          label: payload.taskName?.trim() || summarizeTaskName(prompt),
          ownership: 'managed',
          worktreePath: launchWorktree.worktree.path,
          actor: 'user',
        });
        createdLaneId = lane.id;
        attachSession(lane.id, result.sessionKey, 'system');
        laneId = lane.id;
      } catch (error) {
        const ownedKill = await escalateInterruptOwnedSurface(result.sessionKey);
        const fallbackKill = ownedKill ?? await confirmDiscoveredInterrupt(runtime, result.sessionKey);
        const confirmedDead = 'confirmedDead' in fallbackKill ? fallbackKill.confirmedDead : fallbackKill.confirmed;
        if (!confirmedDead) {
          throw new Error(
            `Runtime launched ${result.sessionKey}, but governance registration failed and process exit could not be confirmed. ${fallbackKill.note}`,
          );
        }
        if (isOwnedOrchestratorSessionKey(result.sessionKey)) {
          const archived = await archiveOwnedRuntimeSession(result.sessionKey);
          if (!archived?.archived) {
            throw new Error(
              `Runtime launched ${result.sessionKey} and was stopped, but its owned session could not be archived after governance registration failed. ${archived?.note ?? ''}`.trim(),
            );
          }
        }
        if (createdLaneId) {
          const { archiveLane } = await import('@/lib/lane/registry');
          archiveLane(createdLaneId, 'system');
        }
        const cleaned = await new WorktreeManager(repoPath).cleanup(launchWorktree.worktree.id, {
          force: true,
          deleteBranch: true,
        });
        if (!cleaned) {
          throw new Error(
            `Runtime launched ${result.sessionKey} and was stopped, but its worktree could not be cleaned after governance registration failed.`,
          );
        }
        return {
          ok: false,
          runtime: runtimeId,
          clientMutationId: payload.clientMutationId,
          surfaceId: result.sessionKey,
          note: `Runtime launch was rolled back because its governance lane could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
          cwd,
          repoPath,
          worktree: null,
          laneId: null,
        };
      }
    }

    return {
      ok: true,
      runtime: runtimeId,
      clientMutationId: payload.clientMutationId,
      surfaceId: result.sessionKey,
      note: launchWorktree?.worktree
        ? `${result.note} Worktree: ${launchWorktree.worktree.branch} at ${launchWorktree.worktree.path}.`
        : result.note,
      cwd,
      repoPath,
      worktree: launchWorktree?.worktree ?? null,
      laneId,
    };
  } catch (error) {
    if (error instanceof RuntimeLaunchPostEffectError) throw error;
    throw new RuntimeLaunchPostEffectError({
      ok: false,
      runtime: runtimeId,
      clientMutationId: payload.clientMutationId,
      surfaceId: result.sessionKey,
      note: `Runtime ${result.sessionKey} was created, but governance registration did not settle: ${error instanceof Error ? error.message : String(error)}`,
      cwd,
      repoPath,
      worktree: launchWorktree?.worktree ?? null,
      laneId: payload.existingLaneId ?? null,
    }, error);
  }
}
