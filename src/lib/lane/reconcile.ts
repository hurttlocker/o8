import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { createApproval } from '@/lib/approvals/store';
import { listLanes, setLaneStatus } from '@/lib/lane/registry';
import type { Lane, LaneRuntime, LaneStatus } from '@/lib/lane/types';
import { getRuntime } from '@/lib/runtimes';

function isStuckLane(lane: Lane) {
  return lane.status === 'running' || lane.status === 'launching';
}

async function discoverSessionKeysByRuntime(lanes: Lane[]) {
  const runtimeIds = [...new Set(lanes.map((lane) => lane.runtime))];
  const discoveredSessionsByRuntime = new Map<LaneRuntime, Set<string> | null>();

  await Promise.all(runtimeIds.map(async (runtimeId) => {
    const runtime = getRuntime(runtimeId);
    if (!runtime) {
      console.warn(`[reconcile] Runtime ${runtimeId} is not registered; skipping lane checks for that runtime`);
      discoveredSessionsByRuntime.set(runtimeId, null);
      return;
    }

    try {
      const sessions = await runtime.discoverSessions();
      discoveredSessionsByRuntime.set(
        runtimeId,
        new Set(sessions.map((session) => session.sessionKey)),
      );
    } catch (error) {
      console.warn(
        `[reconcile] Failed to discover ${runtimeId} sessions during startup reconciliation: ${error instanceof Error ? error.message : String(error)}`,
      );
      discoveredSessionsByRuntime.set(runtimeId, null);
    }
  }));

  return discoveredSessionsByRuntime;
}

function createSessionLostApproval(lane: Lane) {
  const label = lane.label || lane.branch;
  return createApproval({
    source: 'runtime',
    runtime: lane.runtime,
    agent: label,
    sessionKey: lane.sessionKey || `lane:${lane.id}`,
    title: 'Agent session lost',
    description: `The agent session for lane "${label}" was lost during app restart. Resume the task or archive the lane.`,
    summary: `Lane "${label}" needs a resume after app restart`,
    risk: 'medium',
    metadata: {
      Lane: lane.id,
      Branch: lane.branch,
      Runtime: lane.runtime,
      ...(lane.packetId ? { Packet: lane.packetId } : {}),
    },
    continuation: {
      kind: 'lane',
      laneId: lane.id,
      verb: 'resume',
    },
  });
}

// #534 follow-up — orchestrator often bash-merges (git merge + git push) and
// cleans up its worktree without invoking the lane `merge` verb. The git
// state is correct but the lane SQLite record stays stuck in 'reviewing'
// forever because setLaneStatus never fired. Solution: detect lanes whose
// worktree path no longer exists on disk and auto-transition them to
// 'completed'. Model-agnostic — works whether the agent used the merge verb,
// raw bash, or any other path. Synchronous so it can run inside hot request
// handlers without a round-trip to the event loop for each stat call.
const RECONCILABLE_WORKTREE_STATUSES: ReadonlySet<LaneStatus> = new Set<LaneStatus>([
  'reviewing',
  'merging',
  'awaiting_input',
]);

// #558 — Branch existence probe per repo. When the orchestrator bash-merges
// and deletes the branch but leaves the worktree dir intact (or when the agent
// push happens through an external tool), we need a second signal — branch
// gone from the repo's ref list. Grouping by repoPath keeps this O(repos)
// rather than O(lanes) on every reconcile tick.
function getLocalBranchSetForRepo(repoPath: string): Set<string> | null {
  try {
    const output = execFileSync('git', ['branch', '--format=%(refname:short)'], {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    });
    const names = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return new Set(names);
  } catch {
    return null;
  }
}

// #558 — Verify the lane was actually merged into its base branch before
// reconciling on the branch-gone signal. Without this check, the orchestrator's
// cherry-pick-to-tmp-branch workflow looks identical to a real merge: original
// branch deleted, but the lane work landed on tmp-* and never made it to main.
// We look for a "Merge lane <branch>" commit on the base branch's recent history
// — that's the verb=merge / bash-merge canonical pattern.
function laneBranchWasMerged(repoPath: string, baseBranch: string, branch: string): boolean {
  try {
    const output = execFileSync(
      'git',
      ['log', '--format=%s', '-n', '50', baseBranch],
      {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
      },
    );
    const branchToken = branch.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`Merge\\s+(?:branch|lane)\\b.*\\b${branchToken}\\b`, 'i');
    return output.split('\n').some((subject) => pattern.test(subject.trim()));
  } catch {
    return false;
  }
}

export function reconcileOrphanedWorktrees(): number {
  const reconcilableLanes = listLanes().filter(
    (lane) =>
      RECONCILABLE_WORKTREE_STATUSES.has(lane.status)
      && typeof lane.worktreePath === 'string'
      && lane.worktreePath.length > 0,
  );
  if (reconcilableLanes.length === 0) return 0;

  // Worktree-gone candidates (original #541 logic)
  const worktreeGone = reconcilableLanes.filter((lane) => !existsSync(lane.worktreePath!));

  // Branch-gone candidates (#558) — worktree still on disk but branch removed
  // AND the lane was actually merged into its base branch. The merge-verify
  // step prevents the orchestrator's cherry-pick-to-tmp-* workflow from
  // tripping a false-completion (branch deleted, work parked on tmp-*, main
  // not yet updated). Probe once per repo to keep the cost bounded.
  const branchSetsByRepo = new Map<string, Set<string> | null>();
  const branchGone: Lane[] = [];
  for (const lane of reconcilableLanes) {
    if (!existsSync(lane.worktreePath!)) continue; // already caught by worktreeGone
    if (!lane.branch) continue;
    if (!branchSetsByRepo.has(lane.repoPath)) {
      branchSetsByRepo.set(lane.repoPath, getLocalBranchSetForRepo(lane.repoPath));
    }
    const branches = branchSetsByRepo.get(lane.repoPath);
    if (!branches) continue; // probe failed — skip rather than false-positive
    if (branches.has(lane.branch)) continue;
    if (!laneBranchWasMerged(lane.repoPath, lane.baseBranch, lane.branch)) continue;
    branchGone.push(lane);
  }

  const candidates = [...worktreeGone, ...branchGone];
  if (candidates.length === 0) return 0;

  let reconciled = 0;
  const decompositionScans = new Map<string, LaneRuntime>();
  const worktreeGoneIds = new Set(worktreeGone.map((lane) => lane.id));
  for (const lane of candidates) {
    const reason = worktreeGoneIds.has(lane.id)
      ? 'worktree_missing_reconciled'
      : 'branch_merged_reconciled';
    const updated = setLaneStatus(lane.id, 'completed', 'system', reason);
    if (updated) {
      reconciled += 1;
      const signal = worktreeGoneIds.has(lane.id)
        ? `worktree ${lane.worktreePath} is gone`
        : `branch ${lane.branch} is gone (merged+deleted)`;
      console.log(
        `[reconcile] Lane ${lane.id} (${lane.label || lane.branch}) ${signal} — transitioned ${lane.status} → completed`,
      );
      // #544 — When the orchestrator bash-merges and cleans up its worktree,
      // the verb=merge post-merge hook never fires. This catches that case
      // by triggering the same #538 decomposition scan on the merge commit
      // (which is HEAD of baseBranch at this point). One scan per repo is
      // enough — multiple lanes for the same repo share one merge SHA
      // during a dogfood sweep.
      decompositionScans.set(lane.repoPath, lane.runtime);
    }
  }

  if (decompositionScans.size > 0) {
    void (async () => {
      try {
        const { enqueueDecompositionsAfterMerge } = await import('@/lib/dispatch/decomposition-pipeline');
        for (const [repoPath, runtime] of decompositionScans) {
          try {
            await enqueueDecompositionsAfterMerge({ repoPath, runtime });
          } catch (error) {
            console.warn(
              `[reconcile] Decomposition scan failed for ${repoPath}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      } catch (error) {
        console.warn(
          `[reconcile] Failed to load decomposition pipeline: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
  }

  return reconciled;
}

export async function reconcileStuckLanes(): Promise<void> {
  const candidateLanes = listLanes().filter(isStuckLane);
  let recoveredCount = 0;

  if (candidateLanes.length === 0) {
    console.log('[reconcile] Checked 0 lanes, recovered 0 stuck lanes');
    return;
  }

  const discoveredSessionsByRuntime = await discoverSessionKeysByRuntime(candidateLanes);

  for (const lane of candidateLanes) {
    const liveSessionKeys = discoveredSessionsByRuntime.get(lane.runtime);
    if (liveSessionKeys === undefined || liveSessionKeys === null) {
      continue;
    }

    if (lane.sessionKey && liveSessionKeys.has(lane.sessionKey)) {
      continue;
    }

    try {
      const updatedLane = setLaneStatus(lane.id, 'paused', 'system', 'session_lost');
      if (!updatedLane) {
        console.warn(`[reconcile] Lane ${lane.id} disappeared before it could be paused`);
        continue;
      }

      createSessionLostApproval(lane);
      recoveredCount += 1;
    } catch (error) {
      console.warn(
        `[reconcile] Failed to recover lane ${lane.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(`[reconcile] Checked ${candidateLanes.length} lanes, recovered ${recoveredCount} stuck lanes`);
}
