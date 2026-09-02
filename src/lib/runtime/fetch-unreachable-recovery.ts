import { setLaneStatus } from '@/lib/lane/registry';
import { markRepoOriginConfigured } from '@/lib/repos/origin-readiness';
import { enqueueInboxItem, selfHealActiveByKindAndRepo } from '@/lib/supervisor/inbox';
import type { WorktreeFetchUnreachableError } from '@/lib/worktree/manager';

const FETCH_UNREACHABLE_COOLDOWN_MS = 5 * 60_000;
interface FetchUnreachableFailureState {
  failedAtMs: number;
  receiptKeys: Set<string>;
}

const fetchUnreachableFailures = new Map<string, FetchUnreachableFailureState>();

export type FetchUnreachableRecoveryStage = 'pre_lane_receipt' | 'pre_launch_fetch';

export interface FetchUnreachableRecoveryInput {
  error: WorktreeFetchUnreachableError;
  repoPath: string;
  packetId: string | null;
  laneId: string | null;
  runtime: string;
  stage: FetchUnreachableRecoveryStage;
}

export interface FetchUnreachableRecoveryCorrelation {
  packetId: string | null;
  stage: FetchUnreachableRecoveryStage;
}

function recoveryReceiptKey(correlation: FetchUnreachableRecoveryCorrelation): string {
  return `${correlation.packetId ?? ''}\u0000${correlation.stage}`;
}

export function fetchUnreachableCooldownRetrySeconds(
  repoPath: string,
  correlation?: FetchUnreachableRecoveryCorrelation,
): number | null {
  const failure = fetchUnreachableFailures.get(repoPath);
  if (!failure) return null;
  const remainingMs = FETCH_UNREACHABLE_COOLDOWN_MS - (Date.now() - failure.failedAtMs);
  if (remainingMs <= 0) {
    fetchUnreachableFailures.delete(repoPath);
    return null;
  }
  // Repository cooldown suppresses repeated repair work only after this exact
  // packet and stage have a durable inbox receipt. A different packet, or the
  // pre-launch stage after a pre-lane failure, gets one attempt to record its
  // own correlated receipt before throttling can apply.
  if (correlation && !failure.receiptKeys.has(recoveryReceiptKey(correlation))) {
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

  const localRefAgeMinutes = Number.isFinite(error.localRefAgeMs)
    ? Math.round(error.localRefAgeMs / 60_000)
    : null;
  const stalenessLabel = localRefAgeMinutes == null
    ? 'local ref missing or unreadable'
    : `local ref is ${localRefAgeMinutes} min old`;

  // Do not let either launch entry point advance until this durable receipt exists.
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
  const currentFailure = fetchUnreachableFailures.get(repoPath);
  fetchUnreachableFailures.set(repoPath, {
    failedAtMs: Date.now(),
    receiptKeys: new Set([
      ...(currentFailure?.receiptKeys ?? []),
      recoveryReceiptKey({ packetId, stage }),
    ]),
  });
  markRepoOriginConfigured(repoPath);

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
      `[worktree-rebase] ${runtime} launch blocked by fetch_unreachable before lane creation on origin/${error.baseBranch} (packet ${packetId ?? 'none'}, branch ${error.branch}).`,
    );
  }

  return {
    note: `Cannot launch ${runtime}: fetch origin ${error.baseBranch} failed and ${stalenessLabel}. Reconnect and retry.`,
  };
}
