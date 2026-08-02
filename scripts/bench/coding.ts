/**
 * Coding-track benchmark library — head-to-head first-diff quality.
 *
 * Pure functions only: load tasks, blind the diffs, score the verdicts. The
 * runner (run-coding.ts) owns process spawning and file IO.
 *
 * Method constraints encoded here rather than left to the reader, because this
 * track has twice produced a result that is easy to over-read:
 *
 *  - A win is only signal when the margin exceeds NOISE_MARGIN. At N=3 a
 *    one-point edge on a 0-10 scale is noise, and `winsAreSignal` says so.
 *  - Conditions are blinded to neutral labels before judging, and the mapping
 *    is not returned with the blinded set.
 *  - Every reported figure carries its N.
 *
 * Conditions under test are the two runtimes o8 actually dispatches — Claude
 * Code and Codex — plus the governed pipeline that wraps them.
 */

export type CodingCondition = 'codex-alone' | 'claude-alone' | 'o8-governed';

export const CODING_CONDITIONS: CodingCondition[] = [
  'codex-alone',
  'claude-alone',
  'o8-governed',
];

/** A one-point edge on a 0-10 scale is not a result at this N. */
export const NOISE_MARGIN = 1.0;

export interface CodingTask {
  /** GitHub issue number the task is drawn from. */
  issue: number;
  /** Commit the arms branch from. Must predate the issue being fixed. */
  base: string;
  /** Short label for reporting. */
  label: string;
}

export interface CodingSubScores {
  correctness: number;
  scopeDiscipline: number;
  robustness: number;
  fit: number;
}

export interface CodingVerdict {
  task: number;
  /** Neutral label the judge saw. */
  blindLabel: string;
  subScores: CodingSubScores;
  /** Mean of the four sub-scores, one decimal. */
  total: number;
  mostSeriousDefect: string;
}

export interface BlindCodingInput {
  task: number;
  blindLabel: string;
  diffPath: string;
}

export interface CodingTaskResult {
  task: number;
  label: string;
  scores: Partial<Record<CodingCondition, number>>;
  winner: CodingCondition | null;
  /** Gap between best and second-best. */
  margin: number;
  /** False when the margin is inside the noise band. */
  decisive: boolean;
}

export interface CodingSummary {
  tasksScored: number;
  wins: Record<CodingCondition, number>;
  decisiveWins: Record<CodingCondition, number>;
  ranges: Record<CodingCondition, { min: number; max: number } | null>;
  results: CodingTaskResult[];
  /**
   * The pre-registered falsification bar: the governed pipeline improves
   * first-diff quality only on >= 2 of 3 wins with a margin beyond noise.
   */
  governedImprovesQuality: boolean;
  note: string;
}

export function meanSubScores(sub: CodingSubScores): number {
  const total = (sub.correctness + sub.scopeDiscipline + sub.robustness + sub.fit) / 4;
  return Math.round(total * 10) / 10;
}

/**
 * Assign neutral labels. The caller keeps the mapping; it is deliberately not
 * part of the returned value so a judging context cannot receive it by accident.
 */
export function blindCodingDiffs(
  task: number,
  diffPathsByCondition: Record<string, string>,
  shuffle: <T>(items: T[]) => T[],
): { inputs: BlindCodingInput[]; mapping: Record<string, CodingCondition> } {
  const conditions = shuffle(Object.keys(diffPathsByCondition)) as CodingCondition[];
  const labels = ['A', 'B', 'C', 'D', 'E'];
  const inputs: BlindCodingInput[] = [];
  const mapping: Record<string, CodingCondition> = {};
  conditions.forEach((condition, index) => {
    const blindLabel = labels[index] ?? `X${index}`;
    mapping[blindLabel] = condition;
    inputs.push({ task, blindLabel, diffPath: diffPathsByCondition[condition] });
  });
  return { inputs, mapping };
}

/**
 * Strip anything that identifies which tool produced a diff. Worktree paths and
 * agent names leak authorship straight through to the judge.
 */
export function scrubAuthorship(diff: string): string {
  return diff
    .replace(/\/[^\s'"]*bench[^\s'"]*\/t\d+-[a-z0-9]+/gi, '<WORKTREE>')
    .replace(/\b(codex|claude|o8-governed|ginsu)\b/gi, 'AGENT')
    .replace(/implementation-notes\.md/g, 'NOTES.md');
}

function emptyCount(): Record<CodingCondition, number> {
  return { 'codex-alone': 0, 'claude-alone': 0, 'o8-governed': 0 };
}

export function scoreCodingResults(
  tasks: CodingTask[],
  verdicts: CodingVerdict[],
  mappings: Record<number, Record<string, CodingCondition>>,
): CodingSummary {
  const results: CodingTaskResult[] = [];
  const wins = emptyCount();
  const decisiveWins = emptyCount();
  const perCondition: Record<CodingCondition, number[]> = {
    'codex-alone': [],
    'claude-alone': [],
    'o8-governed': [],
  };

  for (const task of tasks) {
    const mapping = mappings[task.issue] ?? {};
    const scores: Partial<Record<CodingCondition, number>> = {};
    for (const verdict of verdicts.filter((v) => v.task === task.issue)) {
      const condition = mapping[verdict.blindLabel];
      if (!condition) continue;
      scores[condition] = verdict.total;
      perCondition[condition].push(verdict.total);
    }

    const ranked = (Object.entries(scores) as [CodingCondition, number][])
      .sort((a, b) => b[1] - a[1]);
    if (ranked.length === 0) continue;

    const [winner, best] = ranked[0];
    const runnerUp = ranked[1]?.[1] ?? best;
    const margin = Math.round((best - runnerUp) * 10) / 10;
    const decisive = margin > NOISE_MARGIN;

    wins[winner] += 1;
    if (decisive) decisiveWins[winner] += 1;

    results.push({ task: task.issue, label: task.label, scores, winner, margin, decisive });
  }

  const ranges = Object.fromEntries(
    (Object.keys(perCondition) as CodingCondition[]).map((condition) => {
      const values = perCondition[condition];
      return [
        condition,
        values.length > 0 ? { min: Math.min(...values), max: Math.max(...values) } : null,
      ];
    }),
  ) as CodingSummary['ranges'];

  const governedImprovesQuality =
    decisiveWins['o8-governed'] >= 2 && results.length >= 3;

  return {
    tasksScored: results.length,
    wins,
    decisiveWins,
    ranges,
    results,
    governedImprovesQuality,
    note:
      `N=${results.length} tasks. A win counts as decisive only when the margin exceeds ` +
      `${NOISE_MARGIN} point on a 0-10 scale; at this N a smaller edge is noise. ` +
      `"governedImprovesQuality" reflects the pre-registered bar: >=2 decisive wins for ` +
      `the governed pipeline. Report counts, never rates.`,
  };
}
