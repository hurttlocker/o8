/**
 * Coding-track benchmark library for paired first-diff quality trials.
 *
 * The first program has two supported runtimes and one causal intervention:
 * each runtime produces a raw arm and a contract-first arm from the same base.
 * The runner owns processes and files; this module owns blinding and scoring.
 */

export type CodingRuntime = 'codex' | 'claude';
export type CodingTreatment = 'raw' | 'contract';
export type CodingCondition = `${CodingRuntime}-${CodingTreatment}`;
export type CodingJudge = CodingRuntime;

export const CODING_RUNTIMES: CodingRuntime[] = ['codex', 'claude'];
export const CODING_TREATMENTS: CodingTreatment[] = ['raw', 'contract'];
export const CODING_CONDITIONS: CodingCondition[] = CODING_RUNTIMES.flatMap((runtime) => (
  CODING_TREATMENTS.map((treatment) => `${runtime}-${treatment}` as CodingCondition)
));
export const CODING_JUDGES: CodingJudge[] = [...CODING_RUNTIMES];

/** A one-point edge on a 0-10 scale is not a result at this N. */
export const NOISE_MARGIN = 1.0;
export const EXCELLENT_SCORE = 9.0;

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
  judge: CodingJudge;
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

export interface CodingPairResult {
  runtime: CodingRuntime;
  raw: number;
  contract: number;
  /** Positive means the contract-first arm scored higher. */
  contractMargin: number;
  winner: CodingTreatment | null;
  decisive: boolean;
}

export interface CodingTaskResult {
  task: number;
  label: string;
  scores: Record<CodingCondition, number>;
  judgeScores: Record<CodingCondition, Record<CodingJudge, number>>;
  winner: CodingCondition | null;
  /** Gap between best and second-best arm. */
  margin: number;
  decisive: boolean;
  pairs: Record<CodingRuntime, CodingPairResult>;
}

export interface CodingRuntimeSummary {
  tasks: number;
  rawWins: number;
  contractWins: number;
  ties: number;
  decisiveRawWins: number;
  decisiveContractWins: number;
}

export interface CodingSummary {
  tasksScored: number;
  wins: Record<CodingCondition, number>;
  decisiveWins: Record<CodingCondition, number>;
  ranges: Record<CodingCondition, { min: number; max: number } | null>;
  excellentOutputs: Record<CodingCondition, number>;
  paired: Record<CodingRuntime, CodingRuntimeSummary>;
  results: CodingTaskResult[];
  /**
   * Pre-registered product bar: contract-first beats raw decisively on at
   * least two of three tasks for each initial runtime.
   */
  contractImprovesQuality: boolean;
  note: string;
}

export function runtimeForCondition(condition: CodingCondition): CodingRuntime {
  return condition.startsWith('claude-') ? 'claude' : 'codex';
}

export function treatmentForCondition(condition: CodingCondition): CodingTreatment {
  return condition.endsWith('-contract') ? 'contract' : 'raw';
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
  diffPathsByCondition: Partial<Record<CodingCondition, string>>,
  shuffle: <T>(items: T[]) => T[],
): { inputs: BlindCodingInput[]; mapping: Record<string, CodingCondition> } {
  const conditions = shuffle(Object.keys(diffPathsByCondition) as CodingCondition[]);
  const labels = ['A', 'B', 'C', 'D', 'E'];
  const inputs: BlindCodingInput[] = [];
  const mapping: Record<string, CodingCondition> = {};
  conditions.forEach((condition, index) => {
    const blindLabel = labels[index] ?? `X${index}`;
    const diffPath = diffPathsByCondition[condition];
    if (!diffPath) return;
    mapping[blindLabel] = condition;
    inputs.push({ task, blindLabel, diffPath });
  });
  return { inputs, mapping };
}

/** Strip benchmark worktree provenance without changing candidate source text. */
export function scrubAuthorship(diff: string): string {
  return diff.replace(/\/[^\s'"]*bench[^\s'"]*\/t\d+-[a-z0-9-]+/gi, '<WORKTREE>');
}

function emptyConditionCount(): Record<CodingCondition, number> {
  return Object.fromEntries(CODING_CONDITIONS.map((condition) => [condition, 0])) as Record<CodingCondition, number>;
}

function emptyRuntimeSummary(): Record<CodingRuntime, CodingRuntimeSummary> {
  return Object.fromEntries(CODING_RUNTIMES.map((runtime) => [runtime, {
    tasks: 0,
    rawWins: 0,
    contractWins: 0,
    ties: 0,
    decisiveRawWins: 0,
    decisiveContractWins: 0,
  }])) as Record<CodingRuntime, CodingRuntimeSummary>;
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function buildPair(
  runtime: CodingRuntime,
  scores: Record<CodingCondition, number>,
): CodingPairResult {
  const raw = scores[`${runtime}-raw`];
  const contract = scores[`${runtime}-contract`];
  const contractMargin = rounded(contract - raw);
  return {
    runtime,
    raw,
    contract,
    contractMargin,
    winner: contractMargin > 0 ? 'contract' : contractMargin < 0 ? 'raw' : null,
    decisive: Math.abs(contractMargin) > NOISE_MARGIN,
  };
}

export function scoreCodingResults(
  tasks: CodingTask[],
  verdicts: CodingVerdict[],
  mappings: Record<number, Record<string, CodingCondition>>,
): CodingSummary {
  const results: CodingTaskResult[] = [];
  const wins = emptyConditionCount();
  const decisiveWins = emptyConditionCount();
  const excellentOutputs = emptyConditionCount();
  const paired = emptyRuntimeSummary();
  const perCondition = Object.fromEntries(
    CODING_CONDITIONS.map((condition) => [condition, [] as number[]]),
  ) as Record<CodingCondition, number[]>;

  for (const task of tasks) {
    const mapping = mappings[task.issue] ?? {};
    const judgeScores = Object.fromEntries(CODING_CONDITIONS.map((condition) => [condition, {}])) as Record<
      CodingCondition,
      Record<CodingJudge, number>
    >;
    for (const verdict of verdicts.filter((entry) => entry.task === task.issue)) {
      const condition = mapping[verdict.blindLabel];
      if (!condition || !CODING_JUDGES.includes(verdict.judge)) continue;
      judgeScores[condition][verdict.judge] = verdict.total;
    }

    const complete = CODING_CONDITIONS.every((condition) => (
      CODING_JUDGES.every((judge) => Number.isFinite(judgeScores[condition][judge]))
    ));
    if (!complete) continue;

    const scores = Object.fromEntries(CODING_CONDITIONS.map((condition) => {
      const values = CODING_JUDGES.map((judge) => judgeScores[condition][judge]);
      return [condition, rounded(values.reduce((sum, value) => sum + value, 0) / values.length)];
    })) as Record<CodingCondition, number>;

    for (const condition of CODING_CONDITIONS) {
      perCondition[condition].push(scores[condition]);
      if (scores[condition] >= EXCELLENT_SCORE) excellentOutputs[condition] += 1;
    }

    const ranked = [...CODING_CONDITIONS]
      .map((condition) => [condition, scores[condition]] as const)
      .sort((a, b) => b[1] - a[1]);
    const best = ranked[0][1];
    const runnerUp = ranked[1][1];
    const winner = best === runnerUp ? null : ranked[0][0];
    const margin = rounded(best - runnerUp);
    const decisive = margin > NOISE_MARGIN;
    if (winner) {
      wins[winner] += 1;
      if (decisive) decisiveWins[winner] += 1;
    }

    const pairs = Object.fromEntries(CODING_RUNTIMES.map((runtime) => {
      const pair = buildPair(runtime, scores);
      const summary = paired[runtime];
      summary.tasks += 1;
      if (pair.winner === 'contract') {
        summary.contractWins += 1;
        if (pair.decisive) summary.decisiveContractWins += 1;
      } else if (pair.winner === 'raw') {
        summary.rawWins += 1;
        if (pair.decisive) summary.decisiveRawWins += 1;
      } else {
        summary.ties += 1;
      }
      return [runtime, pair];
    })) as Record<CodingRuntime, CodingPairResult>;

    results.push({ task: task.issue, label: task.label, scores, judgeScores, winner, margin, decisive, pairs });
  }

  const ranges = Object.fromEntries(CODING_CONDITIONS.map((condition) => {
    const values = perCondition[condition];
    return [condition, values.length > 0 ? { min: Math.min(...values), max: Math.max(...values) } : null];
  })) as CodingSummary['ranges'];

  const contractImprovesQuality = results.length >= 3 && CODING_RUNTIMES.every((runtime) => (
    paired[runtime].decisiveContractWins >= 2
  ));

  return {
    tasksScored: results.length,
    wins,
    decisiveWins,
    ranges,
    excellentOutputs,
    paired,
    results,
    contractImprovesQuality,
    note:
      `N=${results.length} complete tasks, each scored by N=${CODING_JUDGES.length} blinded judges. ` +
      `A paired win is decisive only when the absolute margin exceeds ${NOISE_MARGIN} point. ` +
      `The contract-first intervention clears the product bar only with at least two decisive wins ` +
      `for each initial runtime. Excellent output means score >=${EXCELLENT_SCORE}. Report counts, never rates.`,
  };
}
