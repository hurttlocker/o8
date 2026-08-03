import {
  CODING_JUDGES,
  NOISE_MARGIN,
  type CodingJudge,
  type CodingVerdict,
  scrubAuthorship,
} from './coding';

export type EndToEndCondition = 'adhoc-codex' | 'adhoc-claude' | 'governed';

export const END_TO_END_CONDITIONS: EndToEndCondition[] = [
  'adhoc-codex',
  'adhoc-claude',
  'governed',
];

export interface EndToEndTask {
  issue: number;
  label: string;
}

export interface EndToEndValidityInput {
  condition: EndToEndCondition;
  expectedBase: string;
  changedFiles: string[];
  commandsPassed: boolean;
  mechanicalPassed: boolean | null;
  durableReviewApproved: boolean | null;
  reviewAttempts: number;
  maxReviewAttempts: number;
  diffBase: string | null;
  diffTruncated: boolean;
  pipelineFailureReason: string | null;
}

export interface EndToEndTaskResult {
  task: number;
  label: string;
  shippedDiffs: Record<EndToEndCondition, string>;
  scores: Record<EndToEndCondition, number>;
  judgeScores: Record<EndToEndCondition, Record<CodingJudge, number>>;
  winner: EndToEndCondition | null;
  margin: number;
  judgeAgreement: boolean;
  outcome: EndToEndCondition | 'tie' | 'judges disagree';
  decisive: boolean;
}

export interface EndToEndScoringSummary {
  tasksScored: number;
  governedWins: number;
  decisiveGovernedWins: number;
  results: EndToEndTaskResult[];
  note: string;
}

const EXCLUDED_ARTIFACT_MARKERS = [
  'implementation-notes.md',
  'task-contract.json',
  '/.claude/',
  '/.o8/',
  '/.cortex/',
  '/review-artifacts/',
];

const GENERIC_BLINDING_MARKERS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'managed worktree path', pattern: /[^\s'"]*\/\.cortex-worktrees\/packet-[^\s'"]*/i },
  { label: 'lane id', pattern: /\blane-[a-z0-9]+(?:-[a-z0-9]+)*\b/i },
  { label: 'packet id', pattern: /\bpkt-[a-z0-9]+(?:-[a-z0-9]+)*\b/i },
  { label: 'mission id', pattern: /\bmission-[a-z0-9]+(?:-[a-z0-9]+)*\b/i },
  { label: 'benchmark worker id', pattern: /\bbe2e[a-z0-9]+\b/i },
  { label: 'generated branch', pattern: /\b(?:inline|agent)\/\d{3,}-[a-z0-9._/-]+\b/i },
];

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function removeArtifactDiffs(diff: string): string {
  return diff
    .split(/(?=^diff --git )/m)
    .filter((section) => {
      const header = section.split('\n', 1)[0]?.toLowerCase() ?? '';
      return !EXCLUDED_ARTIFACT_MARKERS.some((marker) => header.includes(marker));
    })
    .join('');
}

export function blindEndToEndDiff(diff: string, provenanceMarkers: string[]): string {
  let blinded = scrubAuthorship(removeArtifactDiffs(diff));
  const markers = [...new Set(provenanceMarkers.map((marker) => marker.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  for (const marker of markers) {
    blinded = blinded.split(marker).join('<BENCHMARK-PROVENANCE>');
  }
  blinded = blinded
    .replace(/[^\s'"]*\/\.cortex-worktrees\/packet-[^\s'"]*/gi, '<WORKTREE>')
    .replace(/\blane-[a-z0-9]+(?:-[a-z0-9]+)*\b/gi, '<LANE>')
    .replace(/\bpkt-[a-z0-9]+(?:-[a-z0-9]+)*\b/gi, '<PACKET>')
    .replace(/\bmission-[a-z0-9]+(?:-[a-z0-9]+)*\b/gi, '<MISSION>')
    .replace(/\bbe2e[a-z0-9]+\b/gi, '<WORKER>')
    .replace(/\b(?:inline|agent)\/\d{3,}-[a-z0-9._/-]+\b/gi, '<BRANCH>');
  return blinded;
}

export function findEndToEndBlindingLeaks(diff: string, provenanceMarkers: string[]): string[] {
  const leaks = provenanceMarkers
    .map((marker) => marker.trim())
    .filter((marker) => marker && diff.includes(marker))
    .map((marker) => `provenance marker ${JSON.stringify(marker)}`);

  for (const marker of EXCLUDED_ARTIFACT_MARKERS) {
    if (diff.toLowerCase().includes(marker)) leaks.push(`artifact marker ${marker}`);
  }
  for (const { label, pattern } of GENERIC_BLINDING_MARKERS) {
    if (pattern.test(diff)) leaks.push(label);
  }
  return [...new Set(leaks)];
}

export function assertEndToEndDiffIsBlind(diff: string, provenanceMarkers: string[]): void {
  const leaks = findEndToEndBlindingLeaks(diff, provenanceMarkers);
  if (leaks.length > 0) {
    throw new Error(`end-to-end blinding leak: ${leaks.join('; ')}`);
  }
}

export function endToEndInvalidReasons(input: EndToEndValidityInput): string[] {
  const reasons = [
    !input.commandsPassed ? 'one or more arm commands failed' : null,
    input.changedFiles.length === 0 ? 'no shipped diff produced' : null,
  ];

  if (input.condition.startsWith('adhoc-')) {
    reasons.push(input.mechanicalPassed !== true ? 'mechanical checks failed' : null);
  } else {
    reasons.push(
      input.durableReviewApproved !== true && input.reviewAttempts >= input.maxReviewAttempts
        ? `governed pipeline did not produce an approved review within ${input.maxReviewAttempts} attempts`
        : null,
      input.durableReviewApproved !== true && input.reviewAttempts < input.maxReviewAttempts
        ? 'governed arm has no durable approved review for current HEAD'
        : null,
      input.diffTruncated ? 'review-approved diff was truncated' : null,
      input.diffBase !== input.expectedBase
        ? `diff base ${input.diffBase ?? '(missing)'} did not match recorded base ${input.expectedBase}`
        : null,
      input.pipelineFailureReason ? `governed pipeline stopped: ${input.pipelineFailureReason}` : null,
    );
  }

  return reasons.filter((reason): reason is string => reason !== null);
}

export function scoreEndToEndResults(
  tasks: EndToEndTask[],
  verdicts: CodingVerdict[],
  mappings: Record<number, Record<string, EndToEndCondition>>,
  shippedDiffs: Record<number, Partial<Record<EndToEndCondition, string>>>,
): EndToEndScoringSummary {
  const results: EndToEndTaskResult[] = [];

  for (const task of tasks) {
    const mapping = mappings[task.issue] ?? {};
    const judgeScores = Object.fromEntries(END_TO_END_CONDITIONS.map((condition) => [condition, {}])) as Record<
      EndToEndCondition,
      Record<CodingJudge, number>
    >;
    for (const verdict of verdicts.filter((entry) => entry.task === task.issue)) {
      const condition = mapping[verdict.blindLabel];
      if (!condition || !CODING_JUDGES.includes(verdict.judge)) continue;
      judgeScores[condition][verdict.judge] = verdict.total;
    }
    const complete = END_TO_END_CONDITIONS.every((condition) => (
      CODING_JUDGES.every((judge) => Number.isFinite(judgeScores[condition][judge]))
      && Boolean(shippedDiffs[task.issue]?.[condition])
    ));
    if (!complete) continue;

    const scores = Object.fromEntries(END_TO_END_CONDITIONS.map((condition) => {
      const values = CODING_JUDGES.map((judge) => judgeScores[condition][judge]);
      return [condition, rounded(values.reduce((sum, value) => sum + value, 0) / values.length)];
    })) as Record<EndToEndCondition, number>;
    const ranked = [...END_TO_END_CONDITIONS]
      .map((condition) => [condition, scores[condition]] as const)
      .sort((left, right) => right[1] - left[1]);
    const winner = ranked[0][1] === ranked[1][1] ? null : ranked[0][0];
    const margin = rounded(ranked[0][1] - ranked[1][1]);
    const judgeAgreement = winner !== null && CODING_JUDGES.every((judge) => (
      END_TO_END_CONDITIONS.every((condition) => (
        condition === winner || judgeScores[winner][judge] > judgeScores[condition][judge]
      ))
    ));
    const outcome = winner === null ? 'tie' : judgeAgreement ? winner : 'judges disagree';

    results.push({
      task: task.issue,
      label: task.label,
      shippedDiffs: shippedDiffs[task.issue] as Record<EndToEndCondition, string>,
      scores,
      judgeScores,
      winner,
      margin,
      judgeAgreement,
      outcome,
      decisive: judgeAgreement && margin > NOISE_MARGIN,
    });
  }

  return {
    tasksScored: results.length,
    governedWins: results.filter((result) => result.outcome === 'governed').length,
    decisiveGovernedWins: results.filter((result) => result.outcome === 'governed' && result.decisive).length,
    results,
    note:
      `N=${results.length} complete end-to-end tasks, each scored by N=${CODING_JUDGES.length} blinded judges. ` +
      `A shipped-diff win is decisive only when the averaged margin exceeds ${NOISE_MARGIN} point and both judges ` +
      'agree on its direction. Judge disagreement is reported instead of resolved by averaging.',
  };
}
