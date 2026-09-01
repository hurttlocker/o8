import { setLaneStatus } from '@/lib/lane/registry';
import { markRepoOriginConfigured } from '@/lib/repos/origin-readiness';
import { enqueueInboxItem, selfHealActiveByKindAndRepo } from '@/lib/supervisor/inbox';
import type { WorktreeFetchUnreachableError } from '@/lib/worktree/manager';

const FETCH_UNREACHABLE_COOLDOWN_MS = 5 * 60_000;
const fetchUnreachableFailures = new Map<string, number>();

export interface FetchUnreachableRecoveryInput {
  error: WorktreeFetchUnreachableError;
  repoPath: string;
  packetId: string | null;
  laneId: string | null;
  runtime: string;
  stage: 'pre_lane_receipt' | 'pre_launch_fetch';
}

export function fetchUnreachableCooldownRetrySeconds(repoPath: string): number | null {
  const lastFailureMs = fetchUnreachableFailures.get(repoPath);
  if (!lastFailureMs) return null;
  const remainingMs = FETCH_UNREACHABLE_COOLDOWN_MS - (Date.now() - lastFailureMs);
  if (remainingMs <= 0) {
    fetchUnreachableFailures.delete(repoPath);
    return null;
  }
  return Math.ceil(remainingMs / 1000);
}

export function recordFetchUnreachableRecoverySuccess(repoPath: string): void {
  fetchUnreachableFailures.delete(repoPath);
  markRepoOriginConfigured(repoPath);
  const healed = selfHealActiveByKindAndRepo('fetch_unreachable', repoPath);
  if (healed > 0) {
    console.log(`[supervisor-inbox] Self-healed ${healed} fetch_unreachable item(s) for ${repoPath} after a clean fetch.`);
  }
}

export function recoverWorktreeFetchUnreachable(input: FetchUnreachableRecoveryInput): { note: string } {
  const { error, laneId, packetId, repoPath, runtime, stage } = input;
  fetchUnreachableFailures.set(repoPath, Date.now());
  markRepoOriginConfigured(repoPath);

  const localRefAgeMinutes = Number.isFinite(error.localRefAgeMs)
    ? Math.round(error.localRefAgeMs / 60_000)
    : null;
  const stalenessLabel = localRefAgeMinutes == null
    ? 'local ref missing or unreadable'
    : `local ref is ${localRefAgeMinutes} min old`;

  if (laneId) {
    try {
      setLaneStatus(laneId, 'awaiting_input', 'system', 'fetch_unreachable');
    } catch (laneError) {
      console.warn(
        `[worktree-rebase] Failed to mark lane ${laneId} as awaiting_input: ${laneError instanceof Error ? laneError.message : laneError}`,
      );
    }
  } else {
    console.warn(
      `[worktree-rebase] ${runtime} packet launch blocked by fetch_unreachable before lane creation on origin/${error.baseBranch} (packet ${packetId ?? 'none'}, branch ${error.branch}).`,
    );
  }

  try {
    enqueueInboxItem({
      repoPath,
      packetId,
      kind: 'fetch_unreachable',
      payload: {
        stage,
        baseBranch: error.baseBranch,
        branch: error.branch,
        laneId,
        packetId,
        runtime,
        localRefAgeMs: Number.isFinite(error.localRefAgeMs) ? error.localRefAgeMs : null,
        fetchErrorMessage: error.fetchErrorMessage,
        errorMessage: error.message,
        errorExcerpt: `Fetch origin ${error.baseBranch} unreachable and ${stalenessLabel}. Reconnect and retry.`,
      },
      status: 'human_required',
    });
  } catch (inboxError) {
    console.warn(
      `[worktree-rebase] Failed to enqueue fetch_unreachable inbox item: ${inboxError instanceof Error ? inboxError.message : inboxError}`,
    );
  }

  return {
    note: `Cannot launch ${runtime}: fetch origin ${error.baseBranch} failed and ${stalenessLabel}. Reconnect and retry.`,
  };
}
