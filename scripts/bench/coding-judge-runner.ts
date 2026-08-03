import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  meanSubScores,
  type CodingJudge,
  type CodingSubScores,
  type CodingTask,
  type CodingVerdict,
} from './coding';
import { JUDGE_PROMPT } from './coding-prompts';

export interface CodingJudgeCommandReceipt {
  command: string;
  status: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  stderrBytes: number;
  spawnErrorCode: string | null;
}

export interface CodingJudgeReceipt {
  task: number;
  judge: CodingJudge;
  promptPath: string;
  outputPath: string;
  replyPath: string;
  command: CodingJudgeCommandReceipt;
  valid: boolean;
  invalidReason: string | null;
}

interface CommandResult {
  receipt: CodingJudgeCommandReceipt;
  stdout: string;
  stderr: string;
}

type RunCommand = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => CommandResult;

function isScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10;
}

function parseJudgeOutput(
  task: CodingTask,
  judge: CodingJudge,
  outputPath: string,
  expectedLabels: string[],
): CodingVerdict[] {
  const parsed = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as Array<{
    blindLabel?: unknown;
    subScores?: Partial<Record<keyof CodingSubScores, unknown>>;
    mostSeriousDefect?: unknown;
  }>;
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
      subScores: {
        correctness: subScores.correctness,
        scopeDiscipline: subScores.scopeDiscipline,
        robustness: subScores.robustness,
        fit: subScores.fit,
      },
      total: meanSubScores(subScores as CodingSubScores),
      mostSeriousDefect: typeof entry.mostSeriousDefect === 'string' ? entry.mostSeriousDefect.trim() : '',
    };
  });
  if (seen.size !== expectedLabels.length) {
    throw new Error(`judge returned ${seen.size}/${expectedLabels.length} required labels`);
  }
  return verdicts;
}

export function runCodingJudge(input: {
  task: CodingTask;
  judge: CodingJudge;
  inputs: Array<{ blindLabel: string; diffPath: string }>;
  baseDir: string;
  repoRoot: string;
  workRoot: string;
  timeoutSeconds: number;
  runCommand: RunCommand;
}): { verdicts: CodingVerdict[]; receipt: CodingJudgeReceipt } {
  const artifactDir = path.join(input.workRoot, 'artifacts');
  const judgeInputDir = path.dirname(input.inputs[0]?.diffPath ?? '');
  const promptPath = path.join(artifactDir, `judge-prompt-${input.task.issue}-${input.judge}.md`);
  const outputPath = path.join(judgeInputDir, 'verdict.json');
  const replyPath = path.join(artifactDir, `judge-reply-${input.task.issue}-${input.judge}.txt`);
  const issuePath = path.join(judgeInputDir, 'issue.md');
  const listing = input.inputs.map((entry) => `- ${entry.blindLabel}: ${entry.diffPath}`).join('\n');
  const prompt = `${JUDGE_PROMPT}\n\nISSUE TEXT: ${issuePath}\nBASE REPOSITORY: ${input.baseDir}\n` +
    `DIFFS TO SCORE:\n${listing}\n\nWrite the JSON array to: ${outputPath}\n` +
    'Write the file even when uncertain; a missing file is an incomplete benchmark.';
  fs.writeFileSync(promptPath, prompt);
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

  const worker = `bjudge${input.task.issue}${input.judge}`;
  const spawn = input.runCommand('ginsu', ['spawn', worker, input.baseDir, '--engine', input.judge], {
    cwd: input.repoRoot,
  });
  let send = { receipt: spawn.receipt, stdout: '', stderr: spawn.stderr };
  if (spawn.receipt.status === 0) {
    try {
      send = input.runCommand('ginsu', ['send', worker, prompt], {
        cwd: input.repoRoot,
        env: { ...process.env, GINSU_TIMEOUT: String(input.timeoutSeconds) },
        timeoutMs: (input.timeoutSeconds + 60) * 1_000,
      });
    } finally {
      input.runCommand('ginsu', ['stop', worker], { cwd: input.repoRoot, timeoutMs: 60_000 });
    }
  }
  fs.writeFileSync(replyPath, send.stdout);

  let verdicts: CodingVerdict[] = [];
  let invalidReason: string | null = null;
  try {
    if (send.receipt.status !== 0) throw new Error('judge turn failed');
    if (!fs.existsSync(outputPath)) throw new Error('judge produced no output file');
    verdicts = parseJudgeOutput(
      input.task,
      input.judge,
      outputPath,
      input.inputs.map((entry) => entry.blindLabel),
    );
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: input.baseDir,
      encoding: 'utf8',
    }).trim();
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
