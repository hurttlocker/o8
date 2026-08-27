import type { ApprovalRecord, OrchestratorReviewFinding } from '@/lib/approvals/types';
import { allFindingsResolved } from '@/lib/approvals/orchestrator-review';
import { resolveLaneAttributionBase } from '@/lib/lane/attribution-base';
import type { Lane } from '@/lib/lane/types';
import type { ContractCoverageResult } from '@/lib/orchestrator/task-contract-coverage';
import type { PacketTaskContract } from '@/lib/orchestrator/types';

export interface DurableReviewAssessment {
  approved: boolean;
  diffBudgetWaived: boolean;
  highConfidence: boolean;
  approvalId: string | null;
  reason: string;
  /**
   * Deterministic per-requirement coverage verdict. Present whenever a sealed
   * contract applied; `null` for legacy packets. Merge preview surfaces
   * `missingRequirementIds` so a targeted repair knows exactly what to fix.
   */
  contractCoverage?: ContractCoverageResult | null;
}

function carriesAcceptedFinding(approval: ApprovalRecord): boolean {
  const findings = approval.args?.findings;
  return Array.isArray(findings) && findings.some((finding) => (
    finding !== null
    && typeof finding === 'object'
    && (finding as { resolution?: unknown }).resolution === 'accepted'
  ));
}

function reviewedHeadForApproval(approval: ApprovalRecord): string | undefined {
  const argsHead = approval.args?.reviewedHeadSha;
  if (typeof argsHead === 'string') {
    return argsHead;
  }

  return approval.metadata?.['Reviewed HEAD'];
}

function reviewVerdictTimestamp(approval: ApprovalRecord): number {
  for (let index = approval.audit.length - 1; index >= 0; index -= 1) {
    const event = approval.audit[index];
    if (event?.type === 'orchestrator_review') return event.timestamp;
  }
  return approval.updatedAt;
}

function reviewFindingsAreResolved(approval: ApprovalRecord): boolean {
  const findings = approval.args?.findings;
  if (findings === undefined) return true;
  if (!Array.isArray(findings)) return false;
  return allFindingsResolved(findings as OrchestratorReviewFinding[]);
}


/**
 * Resolve the sealed contract and the review's recorded evidence, then run the
 * deterministic gate.
 *
 * Fail-closed policy is deliberately narrow: it applies ONLY once we have
 * established that this packet requires a contract. If we cannot even determine
 * that, the packet is treated as legacy and judged exactly as before — blocking
 * work that predates the pipeline would be a regression, not a safety win.
 */
async function assessContractCoverage(
  lane: Pick<Lane, 'id' | 'packetId' | 'worktreePath' | 'repoPath' | 'baseBranch'>,
  approval: ApprovalRecord,
  reviewedHeadSha: string,
): Promise<ContractCoverageResult | null> {
  if (!lane.packetId) return null;

  let contractRequired = false;
  let contract: PacketTaskContract | null = null;
  try {
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const packet = readOrchestratorControlPlaneState().packets.find((entry: { id: string }) => entry.id === lane.packetId);
    if (!packet) return null;
    contractRequired = packet.taskContractRequired === true;
    contract = packet.taskContract ?? null;
  } catch (error) {
    // A packet binding exists but its contract requirement could not be read.
    // Treating that as legacy would let an unverifiable packet merge, so this
    // fails closed. Genuine legacy packets are the `!packet` case above, which
    // returns null and is judged exactly as before.
    console.error(
      `[contract-coverage] control-plane state unreadable for packet ${lane.packetId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      status: 'failed',
      reason: 'Packet state could not be read, so contract coverage is unverifiable.',
      contractVersion: null,
      reviewedHeadSha,
      checks: [],
      missingRequirementIds: [],
    };
  }
  if (!contractRequired) return null;

  try {
    const { evaluateContractCoverage, readCoverageEvidence } =
      await import('@/lib/orchestrator/task-contract-coverage');
    const cwd = lane.worktreePath || lane.repoPath || '';
    const changed = await listChangedPathsForCoverage(lane, cwd, reviewedHeadSha);
    if (!changed.resolved) {
      return {
        status: 'failed',
        reason: 'The packet diff base could not be resolved, so coverage could not be checked against the full change.',
        contractVersion: contract?.version ?? null,
        reviewedHeadSha,
        checks: [],
        missingRequirementIds: contract?.requirements.map((requirement) => requirement.id) ?? [],
      };
    }
    return evaluateContractCoverage({
      contract,
      contractRequired: true,
      evidence: readCoverageEvidence(approval.args),
      reviewedHeadSha,
      changedPaths: changed.paths,
    });
  } catch (error) {
    console.error(
      `[contract-coverage] evaluation failed for packet ${lane.packetId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      status: 'failed',
      reason: 'Contract coverage could not be evaluated, and this packet requires it.',
      contractVersion: contract?.version ?? null,
      reviewedHeadSha,
      checks: [],
      missingRequirementIds: contract?.requirements.map((requirement) => requirement.id) ?? [],
    };
  }
}

/**
 * Paths the packet changed, resolved against the packet's real diff base rather
 * than the previous commit.
 *
 * `HEAD~1..HEAD` was wrong: a multi-commit packet that touched a file in an
 * earlier commit would have its evidence rejected as "not in the change", which
 * fails a correct review for a bookkeeping reason. This reuses the same base
 * resolution merge preview uses, so the gate and the preview agree on what the
 * packet actually changed.
 */
async function listChangedPathsForCoverage(
  lane: Pick<Lane, 'id' | 'baseBranch'>,
  cwd: string,
  headSha: string,
): Promise<{ paths: string[]; resolved: boolean }> {
  if (!cwd) return { paths: [], resolved: false };
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const collect = async (args: string[]): Promise<string[] | null> => {
    try {
      const { stdout } = await run('git', args, { windowsHide: true, cwd, maxBuffer: 8 * 1024 * 1024 });
      return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    } catch {
      return null;
    }
  };

  let comparisonRef: string | null = null;
  try {
    const resolution = await resolveLaneAttributionBase(lane, cwd, headSha);
    comparisonRef = resolution.mergeBase ?? resolution.comparisonRef ?? null;
  } catch {
    comparisonRef = null;
  }

  // Committed range across the whole packet, plus anything still in the tree.
  const committed = comparisonRef ? await collect(['diff', '--name-only', `${comparisonRef}..${headSha}`]) : null;
  const working = await collect(['diff', '--name-only', 'HEAD']);

  // If we could not establish the packet's range, say so rather than silently
  // grading against a narrower set of files than the packet really touched.
  if (committed === null) return { paths: working ?? [], resolved: false };
  return { paths: Array.from(new Set([...committed, ...(working ?? [])])), resolved: true };
}

// Durable approved-review reader. This is the only signal that authorizes a
// non-user merge or PR action to skip the operator approval card.
export async function assessDurableApprovedReview(
  lane: Pick<Lane, 'id' | 'packetId' | 'sessionKey' | 'worktreePath' | 'repoPath' | 'baseBranch'>,
): Promise<DurableReviewAssessment> {
  try {
    const [{ listApprovalsForContext }, { normalizeHeadSha, readHeadSha }] = await Promise.all([
      import('@/lib/approvals/store'),
      import('@/lib/lane/head-sha-lock'),
    ]);
    const approvals = listApprovalsForContext({
      packetId: lane.packetId ?? undefined,
      laneId: lane.id,
      sessionKey: lane.sessionKey ?? undefined,
      projectId: null,
    });
    const completedReviews = approvals.filter(
      (approval) => (
        approval.toolName === 'orchestrator_review'
        && approval.args?.reviewSuperseded !== true
        && typeof approval.args?.reviewTurnId === 'string'
        && approval.args.reviewTurnOutcome === 'completed'
      ),
    );
    if (completedReviews.length === 0) {
      return { approved: false, diffBudgetWaived: false, highConfidence: false, approvalId: null, reason: 'No durable approved AI review exists.' };
    }

    const cwd = lane.worktreePath || lane.repoPath;
    if (!cwd) return { approved: false, diffBudgetWaived: false, highConfidence: false, approvalId: null, reason: 'Lane has no reviewable repository path.' };

    let currentHead: string | undefined;
    try {
      currentHead = normalizeHeadSha(await readHeadSha(cwd));
    } catch {
      return { approved: false, diffBudgetWaived: false, highConfidence: false, approvalId: null, reason: 'Current HEAD could not be verified against the AI review.' };
    }
    if (!currentHead) return { approved: false, diffBudgetWaived: false, highConfidence: false, approvalId: null, reason: 'Current HEAD is unavailable.' };

    const reviewsByRecency = completedReviews.slice().sort((left, right) => (
      reviewVerdictTimestamp(right) - reviewVerdictTimestamp(left)
      || right.updatedAt - left.updatedAt
      || right.id.localeCompare(left.id)
    ));
    const matchingHead = reviewsByRecency.filter((approval) => {
      const reviewed = normalizeHeadSha(reviewedHeadForApproval(approval))?.toLowerCase();
      return reviewed !== undefined && reviewed === currentHead.toLowerCase();
    });
    const latestReview = matchingHead[0];
    if (!latestReview) {
      const reviewed = normalizeHeadSha(reviewedHeadForApproval(reviewsByRecency[0]!));
      return {
        approved: false,
        diffBudgetWaived: false,
        highConfidence: false,
        approvalId: null,
        reason: reviewed
          ? `Review pinned to ${reviewed} but current HEAD is ${currentHead}.`
          : 'The latest AI review is not pinned to the current HEAD.',
      };
    }
    const diffBudgetWaived = latestReview ? carriesAcceptedFinding(latestReview) : false;
    if (
      latestReview.status === 'approved'
      && latestReview.args?.approved !== false
      && reviewFindingsAreResolved(latestReview)
      && latestReview.args?.requiresSecondPass === true
      && latestReview.args?.secondPassAgreed !== true
    ) {
      return {
        approved: false,
        diffBudgetWaived,
        highConfidence: false,
        approvalId: null,
        reason: 'The latest AI review matches the current HEAD and is awaiting its required second pass.',
      };
    }
    const matching = latestReview
      && latestReview.status === 'approved'
      && latestReview.args?.approved !== false
      && reviewFindingsAreResolved(latestReview)
      ? latestReview
      : undefined;
    if (!matching) {
      return { approved: false, diffBudgetWaived, highConfidence: false, approvalId: null, reason: 'The latest AI review does not authorize the current HEAD.' };
    }

    // Coverage gate: an approved-looking review cannot authorize a merge unless
    // every sealed requirement has machine-checked production-path evidence at
    // the HEAD being approved. Legacy packets return not-applicable and pass.
    const coverage = await assessContractCoverage(lane, matching, currentHead);
    if (coverage && coverage.status === 'failed') {
      return {
        approved: false,
        diffBudgetWaived,
        highConfidence: false,
        approvalId: null,
        reason: `Task-contract coverage failed. ${coverage.reason}`,
        contractCoverage: coverage,
      };
    }

    const highConfidence = matching.risk === 'low'
      && typeof matching.args?.parseWarning !== 'string';
    return {
      approved: true,
      contractCoverage: coverage,
      diffBudgetWaived,
      highConfidence,
      approvalId: matching.id,
      reason: highConfidence
        ? 'Current HEAD has a clean, finding-free AI review.'
        : 'The AI review has findings or parser uncertainty.',
    };
  } catch {
    return { approved: false, diffBudgetWaived: false, highConfidence: false, approvalId: null, reason: 'Durable AI review lookup failed.' };
  }
}

export async function supersedeDurableApprovedReviews(packetId: string, reason: string): Promise<number> {
  try {
    const { supersedeOrchestratorReviewApprovals } = await import('@/lib/approvals/store');
    return supersedeOrchestratorReviewApprovals(packetId, reason);
  } catch (error) {
    console.error(
      `[durable-review] Could not supersede approved reviews for packet ${packetId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

export async function hasDurableApprovedReview(
  lane: Pick<Lane, 'id' | 'packetId' | 'sessionKey' | 'worktreePath' | 'repoPath' | 'baseBranch'>,
): Promise<boolean> {
  return (await assessDurableApprovedReview(lane)).approved;
}
