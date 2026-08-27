/**
 * runner.ts — execute one automation against the lane bus.
 *
 * Called by:
 *   1. POST /api/automations/[id]/run         (manual trigger)
 *   2. The cron tick in the background scheduler (P1 task #27)
 *
 * Reuses the same primitives the orchestrator's manual dispatch uses, just
 * server-side and without the UI session-tab hook (`actor: 'system'`).
 *
 * Sequence:
 *   open_lane → prepareLaunchWorktree → bind_worktree (if created) → launch_session
 *
 * Returns the new laneId on success. Caller persists lastLaneId / lastRunAt /
 * lastRunStatus on the automation row.
 */

import { dispatch } from '@/lib/lane/commands';
import { prepareLaunchWorktree } from '@/lib/worktree/launch';
import type { automations } from '@/lib/db/schema';
import type { LaneRuntime } from '@/lib/lane/types';
import type { AgentType } from '@/lib/worktree/types';
import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import { findRepoByLocalPath } from '@/lib/repos/registry';

export interface RunAutomationResult {
  ok: boolean;
  laneId?: string;
  note?: string;
}

function asLaneRuntime(value: string): LaneRuntime {
  // Narrow runtime to the LaneRuntime union; default to 'codex' if unknown
  // so we never throw on a stale row.
  if (ORCHESTRATOR_RUNTIMES[value as LaneRuntime]?.dispatchable) {
    return value as LaneRuntime;
  }
  return 'codex';
}

export async function runAutomation(
  row: typeof automations.$inferSelect,
  promptOverride?: string,
): Promise<RunAutomationResult> {
  const runtime = asLaneRuntime(row.runtime);
  const agentType: AgentType = runtime === 'claude-code' ? 'claude-code' : runtime as AgentType;
  const repo = await findRepoByLocalPath(row.repoPath);
  if (!repo) {
    return { ok: false, note: 'worktree: registered repository not found' };
  }

  // 1. Open the lane.
  const openResult = await dispatch({
    verb: 'open_lane',
    repoPath: row.repoPath,
    projectId: row.projectId ?? null,
    branch: row.branch,
    runtime,
    label: `[automation] ${row.name}`,
    actor: 'system',
  });
  if (!openResult.ok) {
    return { ok: false, note: openResult.note ?? 'open_lane failed' };
  }
  const laneId = openResult.laneId;

  // 2. Prepare a worktree if isolation is needed. Returns null when this is
  //    the only active agent for the repo — agent runs in the repo cwd.
  let worktreeCwd: string | null = null;
  try {
    const wt = await prepareLaunchWorktree({
      repoRoot: row.repoPath,
      agentType,
      taskName: `automation:${row.name}`,
      branchName: row.branch,
      envMode: repo.setup.envMode,
      envFiles: repo.setup.envFiles,
      repoSetup: repo.setup,
      isolationPreference: repo.setup.workspaceIsolationPreference,
    });
    if (wt) worktreeCwd = wt.cwd;
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'worktree prep failed';
    return { ok: false, laneId, note: `worktree: ${reason}` };
  }

  // 3. Bind the worktree to the lane if one was created.
  if (worktreeCwd) {
    const bindResult = await dispatch({
      verb: 'bind_worktree',
      laneId,
      worktreePath: worktreeCwd,
      actor: 'system',
    });
    if (!bindResult.ok) {
      return { ok: false, laneId, note: bindResult.note ?? 'bind_worktree failed' };
    }
  }

  // 4. Launch the agent with the automation's prompt.
  const launchResult = await dispatch({
    verb: 'launch_session',
    laneId,
    prompt: promptOverride ?? row.prompt,
    actor: 'system',
  });
  if (!launchResult.ok) {
    return { ok: false, laneId, note: launchResult.note ?? 'launch_session failed' };
  }

  return { ok: true, laneId, note: launchResult.note };
}
