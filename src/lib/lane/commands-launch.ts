import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { emitProductEvent } from '@/lib/analytics/server';
import { getLanePolicy } from '@/lib/lane/policy';
import { appendEvent, attachSession, getLane, getLaneEvents, setLaneStatus, updateLane } from '@/lib/lane/registry';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { getRuntimeCapability, listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import type { LaneCommand, LaneCommandResult, LaneEventActor, LaneRuntime } from '@/lib/lane/types';
import { findOwnedLaunchByMutationId } from '@/lib/runtimes/shared/owned-session-index';

const LAUNCH_ATTEMPT_CAP = 5;

type LaunchSessionCommand = Extract<LaneCommand, { verb: 'launch_session' }>;

function resolvedLaunchModel(command: LaunchSessionCommand, runtime: LaneRuntime): string | null {
  return command.claudeCodeModel?.trim() || command.model?.trim() || getRuntimeCapability(runtime).defaultModel?.trim() || null;
}

export async function launchSession(
  command: LaunchSessionCommand,
  actor: LaneEventActor,
): Promise<LaneCommandResult> {
  const lane = getLane(command.laneId);
  if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
  if (!listDispatchableRuntimes({ includeExperimental: true }).includes(lane.runtime)) {
    return {
      ok: false,
      laneId: command.laneId,
      note: `Runtime "${lane.runtime}" is not dispatchable. Dispatchable: ${listDispatchableRuntimes({ includeExperimental: true }).join(', ')}.`,
      lane,
    };
  }

  const policy = getLanePolicy(lane.branch);
  if (!policy.branchWritable && !policy.requiresApproval) {
    return { ok: false, laneId: command.laneId, note: `Branch ${lane.branch} is not writable.` };
  }

  const priorLaunchAttempts = getLaneEvents(command.laneId, 200).filter(
    (event) => event.verb === 'status_change' && event.payload?.status === 'launching',
  ).length;
  if (priorLaunchAttempts >= LAUNCH_ATTEMPT_CAP) {
    setLaneStatus(command.laneId, 'failed', 'system', 'launch_attempts_exhausted');
    try {
      updateLane(command.laneId, { sessionKey: null }, 'system');
    } catch (err) {
      console.warn(`[lane] Failed to clear session binding on exhausted lane ${command.laneId}:`, err);
    }
    return {
      ok: false,
      laneId: command.laneId,
      note: `Launch failed ${priorLaunchAttempts}× — giving up. Reset the packet to retry.`,
    };
  }

  const launchCwd = lane.worktreePath ?? lane.repoPath;
  if (launchCwd && !existsSync(launchCwd)) {
    setLaneStatus(command.laneId, 'failed', 'system', 'launch_aborted_missing_cwd');
    return {
      ok: false,
      laneId: command.laneId,
      note: `Working directory no longer exists: ${launchCwd}. Reset the packet to re-provision.`,
    };
  }

  if (command.clientMutationId) {
    const recovered = await findOwnedLaunchByMutationId(command.clientMutationId);
    if (recovered) {
      if (recovered.outcome === 'failed') {
        setLaneStatus(command.laneId, 'idle', 'system', 'launch_failed');
        return {
          ok: false,
          laneId: command.laneId,
          note: 'Recovered a failed owned launch from its durable session record.',
        };
      }
      updateLane(command.laneId, { model: resolvedLaunchModel(command, lane.runtime) }, 'system');
      attachSession(command.laneId, recovered.surfaceId, actor);
      setLaneStatus(command.laneId, 'running', actor, 'session_launch_recovered');
      return {
        ok: true,
        laneId: command.laneId,
        note: 'Recovered the owned launch after an interrupted dispatch response.',
        lane: getLane(command.laneId) ?? undefined,
      };
    }
  }

  setLaneStatus(command.laneId, 'launching', actor, 'launching_session');

  const refreshTarget = (() => {
    if (!lane.worktreePath) return null;
    try {
      const wt = realpathSync(lane.worktreePath);
      return wt === realpathSync(lane.repoPath) ? null : wt;
    } catch {
      return null;
    }
  })();
  if (refreshTarget) {
    try {
      const { getWorktreeManager } = await import('@/lib/worktree');
      await getWorktreeManager(lane.repoPath).rebaseOntoMain(refreshTarget, {
        baseBranch: lane.baseBranch,
        branchName: lane.branch,
      });
      appendEvent(command.laneId, 'worktree_refreshed', 'system', {
        packetId: lane.packetId,
        baseBranch: lane.baseBranch,
        note: `Existing worktree rebased onto current origin/${lane.baseBranch} before launch.`,
      });
    } catch (err) {
      const note = err instanceof Error ? err.message : String(err);
      appendEvent(command.laneId, 'worktree_refresh_failed', 'system', {
        packetId: lane.packetId,
        baseBranch: lane.baseBranch,
        note,
      });
      const rebasing = ['rebase-merge', 'rebase-apply'].some((marker) => {
        try {
          return existsSync(join(refreshTarget, '.git', marker));
        } catch {
          return false;
        }
      });
      if (rebasing) {
        setLaneStatus(command.laneId, 'failed', 'system', 'worktree_mid_rebase');
        return {
          ok: false,
          laneId: command.laneId,
          note: `Worktree at ${refreshTarget} is stuck mid-rebase after a failed refresh (${note}). Reset the packet to re-provision.`,
        };
      }
      console.warn(`[lane] pre-launch worktree refresh failed for ${command.laneId} — launching on the existing base: ${note}`);
    }
  }

  try {
    const { launchRuntimeSurface } = await import('@/lib/runtime/actions');
    const result = await launchRuntimeSurface({
      runtime: lane.runtime,
      prompt: command.prompt,
      repoPath: lane.worktreePath ?? lane.repoPath,
      projectRepoPath: lane.repoPath,
      branchName: lane.branch,
      baseBranch: lane.baseBranch,
      model: command.model,
      claudeCodeModel: command.claudeCodeModel,
      claudeCodeCarrier: command.claudeCodeCarrier,
      effort: command.effort,
      clientMutationId: command.clientMutationId,
      isolate: !lane.worktreePath,
      skipSetup: true,
      existingLaneId: command.laneId,
      packetId: lane.packetId ?? undefined,
      spendCap: command.spendCap,
      storageAdmissionReservationId: command.storageAdmissionReservationId,
    });

    if (!result.ok) {
      setLaneStatus(command.laneId, 'idle', 'system', 'launch_failed');
      return { ok: false, laneId: command.laneId, note: result.note };
    }

    updateLane(command.laneId, { model: resolvedLaunchModel(command, lane.runtime) }, 'system');
    attachSession(command.laneId, result.surfaceId, actor);
    if (result.worktree?.path && !lane.worktreePath) {
      updateLane(command.laneId, { worktreePath: result.worktree.path }, 'system');
    }
    setLaneStatus(command.laneId, 'running', actor, 'session_launched');
    void emitProductEvent('dispatch.started', { runtime: lane.runtime });

    {
      const { wsPort } = resolvePortInfo();
      let watchRegistered = false;
      for (let attempt = 1; attempt <= 2 && !watchRegistered; attempt += 1) {
        try {
          await fetch(`http://127.0.0.1:${wsPort}/supervisor/watch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getOrCreateWsToken()}` },
            body: JSON.stringify({
              surfaceId: result.surfaceId,
              repoPath: lane.repoPath,
              name: lane.label || lane.branch,
              prompt: command.prompt,
              launchContext: command.launchContext,
            }),
            signal: AbortSignal.timeout(3000),
          });
          watchRegistered = true;
        } catch (regErr) {
          if (attempt === 2) {
            console.warn(`[lane] Supervisor watch registration failed for lane ${command.laneId} (${result.surfaceId}) after 2 attempts — completion will rely on the push signal + salvage nets:`, regErr);
          } else {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        }
      }
    }

    const updated = getLane(command.laneId);
    return {
      ok: true,
      laneId: command.laneId,
      note: result.note,
      lane: updated ?? undefined,
      dependencyMaterializationMode: result.worktree?.dependencyMaterialization?.mode ?? null,
    };
  } catch (err) {
    if (getLane(command.laneId)?.status === 'launching') {
      setLaneStatus(command.laneId, 'idle', 'system', 'launch_error');
    }
    const message = err instanceof Error ? err.message : 'Launch failed.';
    return { ok: false, laneId: command.laneId, note: message };
  }
}
