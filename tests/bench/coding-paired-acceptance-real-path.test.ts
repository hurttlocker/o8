import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CODING_CONDITIONS, type CodingCondition } from '../../scripts/bench/coding';

const REPO_ROOT = process.cwd();
const TASKS = [1065, 1144, 928];
const COMMAND_OK = {
  command: 'fixture',
  status: 0,
  signal: null,
  durationMs: 1,
  timedOut: false,
  stderrBytes: 0,
  spawnErrorCode: null,
};

interface PersistedAcceptanceArm {
  task: number;
  condition: CodingCondition;
  outcome: 'valid' | 'failed' | 'invalid';
  treatment: 'raw' | 'contract';
  terminalStatus: 'completed' | 'failed' | 'interrupted' | null;
  contractObserved: boolean | null;
  changedFiles: string[];
  diffPath: string;
  send: typeof COMMAND_OK;
  mechanical: {
    typecheck: typeof COMMAND_OK;
    eslint: typeof COMMAND_OK | null;
    lintedFiles: string[];
  };
}

interface PairedJudgingReceipt {
  receipts: unknown[];
  pairedAcceptance: {
    tasks: Array<{
      task: number;
      complete: boolean;
      reasons: string[];
    }>;
  };
}

interface LatestCodingReceipt {
  judging: {
    pairedAcceptance?: PairedJudgingReceipt['pairedAcceptance'];
  };
}

let fixtureRoot = '';
let fixtureRepo = '';

function git(args: string[], cwd = REPO_ROOT): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function removeRegisteredWorktrees(): void {
  const resolvedRoot = fs.realpathSync(fixtureRoot);
  const resolvedRepo = fs.realpathSync(fixtureRepo);
  const output = git(['worktree', 'list', '--porcelain']);
  const paths = output.split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((worktree) => worktree === resolvedRepo || worktree.startsWith(`${resolvedRoot}${path.sep}`))
    .sort((left, right) => right.length - left.length);
  for (const worktree of paths) {
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: REPO_ROOT });
  }
  execFileSync('git', ['worktree', 'prune'], { cwd: REPO_ROOT });
}

function removeNestedJudgeWorktrees(): void {
  const resolvedRoot = fs.realpathSync(fixtureRoot);
  const resolvedRepo = fs.realpathSync(fixtureRepo);
  const output = git(['worktree', 'list', '--porcelain']);
  const paths = output.split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((worktree) => worktree !== resolvedRepo && worktree.startsWith(`${resolvedRoot}${path.sep}`))
    .sort((left, right) => right.length - left.length);
  for (const worktree of paths) {
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: REPO_ROOT });
  }
  execFileSync('git', ['worktree', 'prune'], { cwd: REPO_ROOT });
}

function installFakeGinsu(binDir: string, logPath: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  const launcher = path.join(binDir, 'ginsu');
  fs.writeFileSync(launcher, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GINSU_LOG, args[0] + '\\n');
if (args[0] === 'send') {
  const prompt = args[2] || '';
  const output = prompt.match(/Write the JSON array to: ([^\\n]+)/)?.[1];
  const labels = [...prompt.matchAll(/^- ([A-D]): /gm)].map((match) => match[1]);
  if (!output || labels.length === 0) process.exit(2);
  fs.writeFileSync(output, JSON.stringify(labels.map((blindLabel) => ({
    blindLabel,
    subScores: { correctness: 8, scopeDiscipline: 8, robustness: 8, fit: 8 },
    mostSeriousDefect: '',
  }))));
}
`, { mode: 0o755 });
  fs.writeFileSync(logPath, '');
}

function validArm(task: number, condition: CodingCondition, diffPath: string): PersistedAcceptanceArm {
  const treatment = condition.endsWith('-contract') ? 'contract' : 'raw';
  return {
    task,
    condition,
    outcome: 'valid',
    treatment,
    terminalStatus: 'completed',
    contractObserved: treatment === 'contract' ? true : false,
    changedFiles: ['src/result.ts'],
    diffPath,
    send: { ...COMMAND_OK },
    mechanical: {
      typecheck: { ...COMMAND_OK },
      eslint: { ...COMMAND_OK },
      lintedFiles: ['src/result.ts'],
    },
  };
}

function writeCollection(
  runId: string,
  mutate: (arm: PersistedAcceptanceArm) => void = () => undefined,
): string {
  const workRoot = path.join(fixtureRoot, 'o8-bench-coding', runId);
  const artifactDir = path.join(workRoot, 'artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });
  const arms = TASKS.flatMap((task) => CODING_CONDITIONS.map((condition) => {
    const diffPath = path.join(artifactDir, `raw-${task}-${condition}.diff`);
    fs.writeFileSync(
      diffPath,
      `diff --git a/src/result.ts b/src/result.ts\n--- a/src/result.ts\n+++ b/src/result.ts\n@@ -1 +1 @@\n-old\n+${condition}\n`,
    );
    const arm = validArm(task, condition, diffPath);
    mutate(arm);
    return arm;
  }));
  for (const task of TASKS) fs.writeFileSync(path.join(artifactDir, `issue-${task}.md`), `Issue ${task}\n`);
  fs.writeFileSync(path.join(workRoot, 'collection.json'), `${JSON.stringify({
    schema: 'o8/coding-collection/v2',
    runId,
    createdAt: '2026-09-12T00:00:00.000Z',
    seed: 20260802,
    armTimeoutSeconds: 2400,
    conditions: CODING_CONDITIONS,
    arms,
    outcomeTotals: { valid: arms.length, failed: 0, invalid: 0 },
    runControl: {
      status: 'completed',
      completedArms: arms.length,
      abortReason: null,
      backendDetail: null,
      backendProbe: null,
    },
    endToEnd: {
      schema: 'o8/coding-end-to-end-collection/v1',
      runId,
      createdAt: '2026-09-12T00:00:00.000Z',
      baseCommit: git(['rev-parse', 'HEAD'], fixtureRepo),
      approvalMode: 'always',
      o8Cli: null,
      governedExistingBranchPolicy: 'reset',
      taskSelection: { schema: 'fixture', tasks: [] },
      conditions: [],
      tasks: [],
      arms: [],
      outcomeTotals: { valid: 0, failed: 0, invalid: 0 },
      runControl: {
        status: 'completed',
        completedArms: 0,
        abortReason: null,
        backendDetail: null,
        backendProbe: null,
      },
    },
  }, null, 2)}\n`);
  return workRoot;
}

function runPersistedJudge(
  label: string,
  mutate?: (arm: PersistedAcceptanceArm) => void,
): {
  receipt: PairedJudgingReceipt;
  latest: LatestCodingReceipt;
  collectionUnchanged: boolean;
  ginsuCalls: string[];
  stdout: string;
} {
  const runId = `paired-acceptance-${label}-${process.pid}`;
  const workRoot = writeCollection(runId, mutate);
  const collectionPath = path.join(workRoot, 'collection.json');
  const originalCollection = fs.readFileSync(collectionPath);
  const binDir = path.join(fixtureRoot, `bin-${label}`);
  const logPath = path.join(fixtureRoot, `ginsu-${label}.log`);
  installFakeGinsu(binDir, logPath);
  const result = spawnSync(
    path.join(REPO_ROOT, 'node_modules/.bin/tsx'),
    ['scripts/bench/run-coding.ts', '--judge'],
    {
      cwd: fixtureRepo,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        TMPDIR: fixtureRoot,
        O8_BENCH_RUN_ID: runId,
        FAKE_GINSU_LOG: logPath,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        NODE_OPTIONS: '--import=./scripts/register-server-only-stub.mjs',
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`judge failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  const receipt = JSON.parse(
    fs.readFileSync(path.join(workRoot, 'judging.json'), 'utf8'),
  ) as PairedJudgingReceipt;
  const latest = JSON.parse(
    fs.readFileSync(path.join(fixtureRepo, 'tests/bench/latest/coding.json'), 'utf8'),
  ) as LatestCodingReceipt;
  const response = {
    receipt,
    latest,
    collectionUnchanged: originalCollection.equals(fs.readFileSync(collectionPath)),
    ginsuCalls: fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean),
    stdout: result.stdout,
  };
  removeNestedJudgeWorktrees();
  return response;
}

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-paired-acceptance-'));
  fixtureRepo = path.join(fixtureRoot, 'repo');
  git(['worktree', 'add', '--detach', fixtureRepo, 'HEAD']);
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(fixtureRepo, 'node_modules'), 'dir');
  fs.copyFileSync(
    path.join(REPO_ROOT, 'scripts/bench/run-coding.ts'),
    path.join(fixtureRepo, 'scripts/bench/run-coding.ts'),
  );
  const helper = path.join(REPO_ROOT, 'scripts/bench/coding-paired-acceptance.ts');
  if (fs.existsSync(helper)) {
    fs.copyFileSync(helper, path.join(fixtureRepo, 'scripts/bench/coding-paired-acceptance.ts'));
  }
});

afterAll(() => {
  removeRegisteredWorktrees();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('paired coding persisted acceptance boundary', () => {
  it.each([
    {
      label: 'worker-failed',
      reason: 'worker terminal status failed',
      mutate: (arm: PersistedAcceptanceArm) => {
        arm.terminalStatus = 'failed';
        arm.send.status = 1;
      },
    },
    {
      label: 'empty-diff',
      reason: 'diff artifact is empty',
      mutate: (arm: PersistedAcceptanceArm) => fs.writeFileSync(arm.diffPath, ''),
    },
    {
      label: 'missing-contract',
      reason: 'treatment contract was not observed',
      mutate: (arm: PersistedAcceptanceArm) => {
        if (arm.condition.endsWith('-contract')) arm.contractObserved = false;
      },
    },
    {
      label: 'contract-condition-labelled-raw',
      reason: 'condition/treatment mismatch',
      mutate: (arm: PersistedAcceptanceArm) => {
        if (arm.condition.endsWith('-contract')) {
          arm.treatment = 'raw';
          arm.contractObserved = false;
        }
      },
    },
    {
      label: 'typecheck-failed',
      reason: 'typecheck failed',
      mutate: (arm: PersistedAcceptanceArm) => {
        arm.mechanical.typecheck.status = 1;
      },
    },
    {
      label: 'eslint-failed',
      reason: 'touched-file eslint failed',
      mutate: (arm: PersistedAcceptanceArm) => {
        if (arm.mechanical.eslint) arm.mechanical.eslint.status = 1;
      },
    },
  ])('refuses every incomplete task when $label evidence contradicts outcome=valid', ({ label, reason, mutate }) => {
    const result = runPersistedJudge(label, mutate);

    expect(result.receipt.receipts).toHaveLength(0);
    expect(result.receipt.pairedAcceptance.tasks).toHaveLength(TASKS.length);
    expect(result.receipt.pairedAcceptance.tasks.every((task) => !task.complete)).toBe(true);
    expect(result.receipt.pairedAcceptance.tasks.every((task) => (
      task.reasons.some((entry) => entry.includes(reason))
    ))).toBe(true);
    expect(result.latest.judging.pairedAcceptance).toEqual(result.receipt.pairedAcceptance);
    expect(result.collectionUnchanged).toBe(true);
    expect(result.ginsuCalls).toEqual([]);
  });

  it('judges every complete valid set and does not require a contract for raw arms', () => {
    const result = runPersistedJudge('valid');

    expect(result.receipt.pairedAcceptance.tasks).toHaveLength(TASKS.length);
    expect(result.receipt.pairedAcceptance.tasks.every((task) => task.complete)).toBe(true);
    expect(result.latest.judging.pairedAcceptance).toEqual(result.receipt.pairedAcceptance);
    expect(result.collectionUnchanged).toBe(true);
    expect(result.receipt.receipts).toHaveLength(TASKS.length * 2);
    expect(result.ginsuCalls.filter((call) => call === 'send')).toHaveLength(TASKS.length * 2);
    expect(result.stdout).toContain('[coding] complete tasks scored: 3');
  });
});
