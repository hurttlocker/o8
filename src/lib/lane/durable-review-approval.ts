import type { ApprovalRecord } from '@/lib/approvals/types';
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
  lane: Pick<Lane, 'packetId' | 'worktreePath' | 'repoPath'>,
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
  } catch {
    // Cannot establish whether a contract applies — treat as legacy.
    return null;
  }
  if (!contractRequired) return null;

  try {
    const { evaluateContractCoverage, readCoverageEvidence } =
      await import('@/lib/orchestrator/task-contract-coverage');
    const cwd = lane.worktreePath || lane.repoPath || '';
    return evaluateContractCoverage({
      contract,
      contractRequired: true,
      evidence: readCoverageEvidence(approval.args),
      reviewedHeadSha,
      changedPaths: await listChangedPathsForCoverage(cwd),
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

/** Paths the packet's change touched, as the gate's notion of "in the change". */
async function listChangedPathsForCoverage(cwd: string): Promise<string[]> {
  if (!cwd) return [];
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const collect = async (args: string[]): Promise<string[]> => {
    try {
      const { stdout } = await run('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
      return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    } catch {
      return [];
    }
  };
  const [committed, working] = await Promise.all([
    collect(['diff', '--name-only', 'HEAD~1..HEAD']),
    collect(['diff', '--name-only', 'HEAD']),
  ]);
  return Array.from(new Set([...committed, ...working]));
}

// Durable approved-review reader. This is the only signal that authorizes a
// non-user merge or PR action to skip the operator approval card.
export async function assessDurableApprovedReview(
  lane: Pick<Lane, 'id' | 'packetId' | 'sessionKey' | 'worktreePath' | 'repoPath'>,
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
    const approved = approvals.filter(
      (approval) => (
        approval.toolName === 'orchestrator_review'
        && approval.status === 'approved'
        && approval.args?.reviewSuperseded !== true
        && typeof approval.args?.reviewTurnId === 'string'
        && approval.args.reviewTurnOutcome === 'completed'
      ),
    );
    if (approved.length === 0) {
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

    const matchingHead = approved.filter((approval) => {
      const reviewed = normalizeHeadSha(reviewedHeadForApproval(approval));
      return reviewed !== undefined && reviewed === currentHead;
    });
    const diffBudgetWaived = matchingHead.some(carriesAcceptedFinding);
    const matching = matchingHead.find((approval) => (
      !(approval.args?.requiresSecondPass === true && approval.args?.secondPassAgreed !== true)
    ));
    if (!matching) {
      return { approved: false, diffBudgetWaived, highConfidence: false, approvalId: null, reason: 'The approved AI review does not authorize the current HEAD.' };
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
  lane: Pick<Lane, 'id' | 'packetId' | 'sessionKey' | 'worktreePath' | 'repoPath'>,
): Promise<boolean> {
  return (await assessDurableApprovedReview(lane)).approved;
}
