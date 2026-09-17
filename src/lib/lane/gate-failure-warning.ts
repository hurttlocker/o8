/**
 * Gate-failure early warning (#2437, tracker #2433). ADVISORY ONLY.
 *
 * Before the layer-1 automatic rerun after a post-rebase verification failure,
 * and only when `judgment.provider` is on, ask the referee's locked risk
 * question about the packet's current diff. The diff comes from git in the
 * lane's worktree, the same way the approval card reads it, never from a
 * worker-written title or summary. Nothing reads the answer: the rerun fires
 * exactly as it would without it. A null answer (setting off, missing key,
 * failed call, abstain) yields null and the caller records nothing.
 *
 * The call is bounded by the judgment client's own timeout and retry budget.
 */
import { createHash } from 'node:crypto';

import { askJudgment, thresholdAnswer, type AskJudgmentOptions } from '@/lib/judgment/client';
import { buildDiffState } from '@/lib/judgment/diff-state';
import { DIFF_QUESTIONS } from '@/lib/judgment/questions';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
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

let transportOverride: AskJudgmentOptions | undefined;

/** Test-only: point the warning at a local endpoint fixture. */
export function setGateFailureWarningTransportForTests(options: AskJudgmentOptions | undefined): void {
  transportOverride = options;
}

function diffFingerprint(diffText: string, paths: readonly string[]): string {
  const hash = createHash('sha256');
  hash.update(diffText);
  for (const path of [...paths].sort()) hash.update(`\0${path}`);
  return hash.digest('hex');
}

/** Ask for the diff's gate-failure risk. Never throws; null means record nothing. */
export async function assessGateFailureRisk(
  lane: Pick<Lane, 'id' | 'packetId' | 'baseBranch' | 'worktreePath' | 'repoPath'>,
): Promise<GateFailureWarning | null> {
  try {
    if (!lane.packetId) return null;
    if (getOperatorDefaultsSync().values.judgmentProvider === 'off') return null;
    const { getDiffForLane } = await import('@/lib/lane/commands-approval');
    const { parseGitDiff } = await import('@/lib/worktree/diff-parser');
    const diffText = await getDiffForLane(lane);
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
    }, transportOverride);
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
      diffFingerprint: diffFingerprint(diffText, files.map((file) => file.path)),
    };
  } catch (error) {
    console.warn('[gate-failure-warning] skipped:', error instanceof Error ? error.message : 'error');
    return null;
  }
}
