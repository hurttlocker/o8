/**
 * Gate-failure early warning (#2437, tracker #2433). ADVISORY ONLY.
 *
 * Before the layer-1 automatic rerun after a post-rebase verification failure,
 * and only when `judgment.provider` is on, ask the referee's locked risk
 * question about the packet's current diff. The diff comes from git, the same
 * command shape the approval card uses, run in the DETACHED INTEGRATION
 * worktree the verification just failed in — not the lane's persistent
 * worktree, whose tree is the pre-rebase one and differs from the verified
 * tree whenever the base moved or a conflict was resolved. No worker-written
 * title or summary reaches the state. Nothing reads the answer: the rerun
 * fires exactly as it would without it. A null answer (setting off, missing
 * key, failed call, abstain) yields null and the caller records nothing.
 *
 * The merge command's result waits on this call, so the surface asks for a
 * single attempt (`maxAttempts: 1`) through the client's per-call override:
 * at most one client timeout (10s), with no retries or backoff.
 */
import { approvalDiffFingerprint } from '@/lib/approvals/referee';
import { askJudgment, thresholdAnswer, type AskJudgmentOptions } from '@/lib/judgment/client';
import { buildDiffState } from '@/lib/judgment/diff-state';
import { DIFF_QUESTIONS } from '@/lib/judgment/questions';
import { isJudgmentRefereeEnabled } from '@/lib/judgment/route';
import type { Lane } from '@/lib/lane/types';

export const GATE_FAILURE_WARNING_SURFACE = 'gate-failure-warning';

const RISK_QUESTIONS = { risk: DIFF_QUESTIONS.risk } as const;

/** Payload of the `gate_failure_warning` lane event. */
export interface GateFailureWarning {
  receiptId: string | null;
  packetId: string;
  risk: number;
  legend: Record<string, string>;
  confidence: number;
  abstain: boolean;
  truncated: boolean;
  hiddenText: boolean;
  /** sha256 over the diff text and the sorted changed-file paths. */
  diffFingerprint: string;
}

/** One attempt: the merge result waits on this call. */
const WARNING_TRANSPORT: AskJudgmentOptions = { maxAttempts: 1 };

let transportOverride: AskJudgmentOptions | undefined;

/** Test-only: point the warning at a local endpoint fixture. */
export function setGateFailureWarningTransportForTests(options: AskJudgmentOptions | undefined): void {
  transportOverride = options;
}

/** Ask for the diff's gate-failure risk. Never throws; null means record nothing. */
export async function assessGateFailureRisk(
  lane: Pick<Lane, 'id' | 'packetId' | 'baseBranch' | 'worktreePath' | 'repoPath'>,
  /** The tree the post-rebase verification ran in; falls back to the lane's own worktree. */
  verifiedWorktreePath?: string | null,
): Promise<GateFailureWarning | null> {
  try {
    if (!lane.packetId) return null;
    if (!isJudgmentRefereeEnabled()) return null;
    const { getDiffForLane } = await import('@/lib/lane/commands-approval');
    const { parseGitDiff } = await import('@/lib/worktree/diff-parser');
    const diffText = await getDiffForLane({
      baseBranch: lane.baseBranch,
      worktreePath: verifiedWorktreePath || lane.worktreePath,
      repoPath: lane.repoPath,
    });
    const files = parseGitDiff(diffText).map((file) => ({ path: file.path }));
    if (!diffText.trim() && files.length === 0) return null;

    const built = buildDiffState(files, diffText);
    const result = await askJudgment({
      state: built.state,
      questions: RISK_QUESTIONS,
      context: {
        packetId: lane.packetId,
        laneId: lane.id,
        surface: GATE_FAILURE_WARNING_SURFACE,
        truncated: built.truncated,
        hiddenText: built.hiddenText,
      },
    }, { ...WARNING_TRANSPORT, ...transportOverride });
    const risk = thresholdAnswer(result?.answers.risk);
    if (!result || !risk) return null;
    return {
      receiptId: result.receiptId,
      packetId: lane.packetId,
      risk: risk.score,
      legend: risk.legend,
      confidence: risk.confidence,
      abstain: risk.abstain,
      truncated: built.truncated,
      hiddenText: built.hiddenText,
      diffFingerprint: approvalDiffFingerprint(diffText, files.map((file) => file.path)),
    };
  } catch (error) {
    console.warn('[gate-failure-warning] skipped:', error instanceof Error ? error.message : 'error');
    return null;
  }
}
