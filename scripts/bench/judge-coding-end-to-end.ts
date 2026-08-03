import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CODING_JUDGES,
  type CodingJudge,
  type CodingSubScores,
  type CodingVerdict,
  meanSubScores,
} from './coding';
import { countArmOutcomes, isScorableArmOutcome, type ArmOutcomeTotals } from './coding-arm-outcome';
import {
  END_TO_END_CONDITIONS,
  assertEndToEndDiffIsBlind,
  blindEndToEndDiff,
  scoreEndToEndResults,
  type EndToEndCondition,
  type EndToEndScoringSummary,
  type EndToEndTask,
} from './coding-end-to-end';
import type { EndToEndCommandReceipt } from './coding-end-to-end-command';
import { JUDGE_PROMPT } from './coding-prompts';
import type {
  EndToEndArmReceipt,
  EndToEndCollectionReceipt,
} from './run-coding-end-to-end';

const MAX_DIFF_BYTES = 32 * 1024 * 1024;

interface EndToEndJudgeReceipt {
  task: number;
  judge: CodingJudge;
  promptPath: string;
  outputPath: string;
  replyPath: string;
  command: EndToEndCommandReceipt;
  valid: boolean;
  invalidReason: string | null;
}

interface EndToEndJudgingProgressReceipt {
  schema: 'o8/coding-end-to-end-judging/v1';
  runId: string;
  startedAt: string;
  receipts: unknown[];
  blindVerdicts: unknown[];
}

export interface EndToEndExperimentResult extends EndToEndScoringSummary {
  baseCommit: string;
  conditions: EndToEndCondition[];
  outcomeTotals: ArmOutcomeTotals;
  failedArms: Array<{
    task: number;
    condition: EndToEndCondition;
    diffPath: string;
    reason: string;
  }>;
  invalidArms: Array<{
    task: number;
    condition: EndToEndCondition;
    diffPath: string;
    reasons: string[];
    reviewAttempts: Array<{ attempt: number; summary: string; findings: unknown[] }>;
  }>;
  judging: {
    receipts: EndToEndJudgeReceipt[];
    mappings: Record<number, Record<string, EndToEndCondition>>;
  };
}

interface CommandResult {
  receipt: EndToEndCommandReceipt;
  stdout: string;
  stderr: string;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): CommandResult {
  const startedAt = Date.now();
  const result: SpawnSyncReturns<string> = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: MAX_DIFF_BYTES,
    timeout: options.timeoutMs,
  });
  const errorCode = result.error && 'code' in result.error ? String(result.error.code) : '';
  return {
    receipt: {
      command: command === 'ginsu' && args[0] === 'send'
        ? `ginsu send ${args[1] ?? '(unknown)'} <PROMPT>`
        : [command, ...args].join(' '),
      status: result.status,
      signal: result.signal,
      durationMs: Date.now() - startedAt,
      timedOut: errorCode === 'ETIMEDOUT',
      stderrBytes: Buffer.byteLength(result.stderr || '', 'utf8'),
      spawnErrorCode: errorCode || null,
    },
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  };
}

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

export function resolveJudgingProgress(input: {
  judgingPath: string;
  runId: string;
  now?: string;
}): { startedAt: string; createReceipt: boolean } {
  if (!fs.existsSync(input.judgingPath)) {
    return { startedAt: input.now ?? new Date().toISOString(), createReceipt: true };
  }
  const receipt = parseJson<Partial<EndToEndJudgingProgressReceipt>>(
    fs.readFileSync(input.judgingPath, 'utf8'),
    'end-to-end judging receipt',
  );
  if (
    receipt.schema !== 'o8/coding-end-to-end-judging/v1'
    || receipt.runId !== input.runId
    || typeof receipt.startedAt !== 'string'
    || !Array.isArray(receipt.receipts)
    || !Array.isArray(receipt.blindVerdicts)
  ) {
    throw new Error('end-to-end judging receipt is malformed or belongs to another run');
  }
  if (receipt.receipts.length > 0 || receipt.blindVerdicts.length > 0) {
    throw new Error('end-to-end judging receipt already contains results; use a new immutable run ID');
  }
  return { startedAt: receipt.startedAt, createReceipt: false };
}

function assertCollectedDiffsAreBlindable(collection: EndToEndCollectionReceipt): void {
  for (const task of collection.tasks) {
    for (const condition of END_TO_END_CONDITIONS) {
      const arm = collection.arms.find((candidate) => (
        candidate.task === task.issue
        && candidate.condition === condition
        && isScorableArmOutcome(candidate.outcome)
      ));
      if (!arm) continue;
      const blinded = blindEndToEndDiff(fs.readFileSync(arm.diffPath, 'utf8'), arm.provenanceMarkers);
      assertEndToEndDiffIsBlind(blinded, arm.provenanceMarkers);
    }
  }
}

function prepareDetachedWorktree(
  repoRoot: string,
  managedRoot: string,
  dir: string,
  expectedName: string,
  base: string,
): string {
  const resolvedRoot = path.resolve(managedRoot);
  const resolved = path.resolve(dir);
  if (resolved !== path.join(resolvedRoot, expectedName) || path.dirname(resolved) !== resolvedRoot) {
    throw new Error(`refusing unmanaged end-to-end judge worktree path: ${dir}`);
  }
  execFileSync('git', ['worktree', 'add', '-q', '--detach', dir, base], { cwd: repoRoot });
  const modules = path.join(dir, 'node_modules');
  if (!fs.existsSync(modules)) fs.symlinkSync(path.join(repoRoot, 'node_modules'), modules, 'dir');
  return dir;
}

function seededShuffle(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
  return <T,>(items: T[]): T[] => {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(next() * (index + 1));
      [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
    }
    return copy;
  };
}

function isScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10;
}

function parseJudgeOutput(
  task: EndToEndTask,
  judge: CodingJudge,
  outputPath: string,
  expectedLabels: string[],
): CodingVerdict[] {
  const parsed = parseJson<Array<{
    blindLabel?: unknown;
    subScores?: Partial<Record<keyof CodingSubScores, unknown>>;
    mostSeriousDefect?: unknown;
  }>>(fs.readFileSync(outputPath, 'utf8'), 'end-to-end judge output');
  if (!Array.isArray(parsed)) throw new Error('judge output is not an array');
  const seen = new Set<string>();
  const verdicts = parsed.map((entry) => {
    const blindLabel = typeof entry.blindLabel === 'string' ? entry.blindLabel.trim() : '';
    if (!expectedLabels.includes(blindLabel) || seen.has(blindLabel)) {
      throw new Error(`judge returned unexpected or duplicate label ${JSON.stringify(blindLabel)}`);
    }
    seen.add(blindLabel);
    const subScores = entry.subScores;
    if (!subScores
      || !isScore(subScores.correctness)
      || !isScore(subScores.scopeDiscipline)
      || !isScore(subScores.robustness)
      || !isScore(subScores.fit)) {
      throw new Error(`judge returned invalid sub-scores for ${blindLabel}`);
    }
    return {
      task: task.issue,
      blindLabel,
      judge,
      subScores: subScores as CodingSubScores,
      total: meanSubScores(subScores as CodingSubScores),
      mostSeriousDefect: typeof entry.mostSeriousDefect === 'string' ? entry.mostSeriousDefect.trim() : '',
    };
  });
  if (seen.size !== expectedLabels.length) {
    throw new Error(`judge returned ${seen.size}/${expectedLabels.length} required labels`);
  }
  return verdicts;
}

function runJudge(input: {
  repoRoot: string;
  workRoot: string;
  task: EndToEndTask;
  judge: CodingJudge;
  inputs: Array<{ blindLabel: string; diffPath: string }>;
  baseDir: string;
}): { verdicts: CodingVerdict[]; receipt: EndToEndJudgeReceipt } {
  const artifactDir = path.join(input.workRoot, 'artifacts', 'end-to-end');
  const judgeInputDir = path.dirname(input.inputs[0]?.diffPath ?? '');
  const promptPath = path.join(artifactDir, `judge-prompt-${input.task.issue}-${input.judge}.md`);
  const outputPath = path.join(judgeInputDir, 'verdict.json');
  const replyPath = path.join(artifactDir, `judge-reply-${input.task.issue}-${input.judge}.txt`);
  const listing = input.inputs.map((candidate) => `- ${candidate.blindLabel}: ${candidate.diffPath}`).join('\n');
  const prompt = `${JUDGE_PROMPT}\n\nISSUE TEXT: ${path.join(judgeInputDir, 'issue.md')}\n` +
    `BASE REPOSITORY: ${input.baseDir}\nDIFFS TO SCORE:\n${listing}\n\nWrite the JSON array to: ${outputPath}\n` +
    'Write the file even when uncertain; a missing file is an incomplete benchmark.';
  fs.writeFileSync(promptPath, prompt);

  const worker = `be2ejudge${input.task.issue}${input.judge}`;
  const spawn = runCommand('ginsu', ['spawn', worker, input.baseDir, '--engine', input.judge], { cwd: input.repoRoot });
  let send = spawn;
  if (spawn.receipt.status === 0) {
    try {
      send = runCommand('ginsu', ['send', worker, prompt], {
        cwd: input.repoRoot,
        env: { ...process.env, GINSU_TIMEOUT: '1800' },
        timeoutMs: 31 * 60_000,
      });
    } finally {
      runCommand('ginsu', ['stop', worker], { cwd: input.repoRoot, timeoutMs: 60_000 });
    }
  }
  fs.writeFileSync(replyPath, send.stdout);

  let verdicts: CodingVerdict[] = [];
  let invalidReason: string | null = null;
  try {
    if (send.receipt.status !== 0) throw new Error('judge turn failed');
    if (!fs.existsSync(outputPath)) throw new Error('judge produced no output file');
    verdicts = parseJudgeOutput(input.task, input.judge, outputPath, input.inputs.map((candidate) => candidate.blindLabel));
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: input.baseDir, encoding: 'utf8' }).trim();
    if (status) throw new Error('judge modified its base worktree');
  } catch (error) {
    invalidReason = error instanceof Error ? error.message : String(error);
    verdicts = [];
  }
  return {
    verdicts,
    receipt: {
      task: input.task.issue,
      judge: input.judge,
      promptPath,
      outputPath,
      replyPath,
      command: send.receipt,
      valid: invalidReason === null,
      invalidReason,
    },
  };
}

export function judgeEndToEnd(input: {
  repoRoot: string;
  workRoot: string;
  seed: number;
  collection: EndToEndCollectionReceipt;
}): EndToEndExperimentResult {
  if (input.collection.runControl?.status === 'infrastructure-aborted') {
    throw new Error(
      `${input.collection.runControl.abortReason ?? 'coding collection infrastructure-aborted'}; ` +
      `arms completed before abort=${input.collection.runControl.completedArms}`,
    );
  }
  const judgingPath = path.join(input.workRoot, 'end-to-end-judging.json');
  assertCollectedDiffsAreBlindable(input.collection);
  const judgingProgress = resolveJudgingProgress({
    judgingPath,
    runId: input.collection.runId,
  });
  const verdicts: CodingVerdict[] = [];
  const receipts: EndToEndJudgeReceipt[] = [];
  const mappings: Record<number, Record<string, EndToEndCondition>> = {};
  const shippedDiffs: Record<number, Partial<Record<EndToEndCondition, string>>> = {};
  const shuffle = seededShuffle(input.seed ^ 0xe2e2026);
  const { startedAt } = judgingProgress;
  if (judgingProgress.createReceipt) {
    writeJson(judgingPath, {
      schema: 'o8/coding-end-to-end-judging/v1',
      runId: input.collection.runId,
      startedAt,
      receipts,
      blindVerdicts: verdicts,
    });
  }

  for (const task of input.collection.tasks) {
    const arms = END_TO_END_CONDITIONS.map((condition) => input.collection.arms.find((arm) => (
      arm.task === task.issue && arm.condition === condition && isScorableArmOutcome(arm.outcome)
    )));
    if (arms.some((arm) => !arm)) {
      console.warn(`[coding:e2e] #${task.issue}: incomplete scorable arm set; task excluded from scoring`);
      continue;
    }
    const conditions = shuffle([...END_TO_END_CONDITIONS]);
    const mapping = Object.fromEntries(conditions.map((condition, index) => (
      [String.fromCharCode(65 + index), condition]
    ))) as Record<string, EndToEndCondition>;
    mappings[task.issue] = mapping;
    shippedDiffs[task.issue] = {};
    for (const arm of arms as EndToEndArmReceipt[]) shippedDiffs[task.issue][arm.condition] = arm.diffPath;

    for (const judge of CODING_JUDGES) {
      const scope = fs.mkdtempSync(path.join(os.tmpdir(), `o8-e2e-blind-${task.issue}-`));
      const inputDir = path.join(scope, 'inputs');
      fs.mkdirSync(inputDir);
      fs.copyFileSync((arms[0] as EndToEndArmReceipt).issuePath, path.join(inputDir, 'issue.md'));
      const judgeInputs = Object.entries(mapping).map(([blindLabel, condition]) => {
        const arm = (arms as EndToEndArmReceipt[]).find((candidate) => candidate.condition === condition)!;
        const blinded = blindEndToEndDiff(fs.readFileSync(arm.diffPath, 'utf8'), arm.provenanceMarkers);
        assertEndToEndDiffIsBlind(blinded, arm.provenanceMarkers);
        const diffPath = path.join(inputDir, `${blindLabel}.diff`);
        fs.writeFileSync(diffPath, blinded);
        return { blindLabel, diffPath };
      });
      const baseDir = prepareDetachedWorktree(
        input.repoRoot,
        scope,
        path.join(scope, 'base'),
        'base',
        input.collection.baseCommit,
      );
      const result = runJudge({
        repoRoot: input.repoRoot,
        workRoot: input.workRoot,
        task,
        judge,
        inputs: judgeInputs,
        baseDir,
      });
      verdicts.push(...result.verdicts);
      receipts.push(result.receipt);
      writeJson(judgingPath, {
        schema: 'o8/coding-end-to-end-judging/v1',
        runId: input.collection.runId,
        startedAt,
        receipts,
        blindVerdicts: verdicts,
      });
    }
  }

  const summary = scoreEndToEndResults(input.collection.tasks, verdicts, mappings, shippedDiffs);
  const failedArms = input.collection.arms.filter((arm) => arm.outcome === 'failed').map((arm) => ({
    task: arm.task,
    condition: arm.condition,
    diffPath: arm.diffPath,
    reason: arm.classificationReason,
  }));
  const invalidArms = input.collection.arms.filter((arm) => arm.outcome === 'invalid').map((arm) => ({
    task: arm.task,
    condition: arm.condition,
    diffPath: arm.diffPath,
    reasons: [arm.classificationReason, ...arm.measurementNotes],
    reviewAttempts: arm.governed?.reviewAttempts?.map((attempt) => ({
      attempt: attempt.attempt,
      summary: attempt.summary,
      findings: attempt.findings,
    })) ?? [],
  }));
  for (const task of input.collection.tasks) {
    const taskArms = input.collection.arms.filter((arm) => arm.task === task.issue);
    console.log(
      `[coding:e2e] #${task.issue} shipped diffs: ` +
      taskArms.map((arm) => `${arm.condition}=${arm.diffPath}`).join(' '),
    );
    const result = summary.results.find((candidate) => candidate.task === task.issue);
    if (!result) {
      const invalid = taskArms.filter((arm) => arm.outcome === 'invalid');
      console.log(
        `[coding:e2e] #${task.issue} unscored: ` +
        invalid.map((arm) => `${arm.condition}=${arm.classificationReason}`).join(' | '),
      );
      continue;
    }
    for (const condition of END_TO_END_CONDITIONS) {
      console.log(
        `[coding:e2e] #${task.issue} ${condition} ` +
        CODING_JUDGES.map((judge) => `${judge}=${result.judgeScores[condition][judge]}`).join(' ') +
        ` average=${result.scores[condition]}`,
      );
    }
    console.log(
      `[coding:e2e] #${task.issue} winner=${result.outcome} margin=${result.margin} ` +
      `judgeAgreement=${result.judgeAgreement} decisive=${result.decisive}`,
    );
  }
  writeJson(judgingPath, {
    schema: 'o8/coding-end-to-end-judging/v1',
    runId: input.collection.runId,
    completedAt: new Date().toISOString(),
    receipts,
    blindVerdicts: verdicts,
    mappings,
  });
  return {
    ...summary,
    baseCommit: input.collection.baseCommit,
    conditions: [...END_TO_END_CONDITIONS],
    outcomeTotals: countArmOutcomes(input.collection.arms),
    failedArms,
    invalidArms,
    judging: { receipts, mappings },
  };
}
