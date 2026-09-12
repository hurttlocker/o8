import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  codingPairedCommands,
  codingPairedRuntimeConfig,
  createCodingPairedFixture,
  runCodingPairedCli,
  type CodingPairedFixtureMode,
} from './coding-paired-process-fixture';

const TASKS = [1065, 1144, 928];
const createdRoots: string[] = [];

interface PersistedAcceptanceArm {
  task: number;
  condition: string;
  runtime: 'codex' | 'claude';
  outcome: 'valid' | 'failed' | 'invalid';
  requestedSettings: { model: string; effort: string };
  treatment: 'raw' | 'contract';
  terminalStatus: 'completed' | 'failed' | 'interrupted' | null;
  contractObserved: boolean | null;
  changedFiles: string[];
  diffPath: string;
  dependencies: { destination: string; owned: boolean; symbolicLink: boolean };
}

interface PairedJudgingReceipt {
  receipts: unknown[];
  pairedAcceptance: {
    tasks: Array<{
      task: number;
      complete: boolean;
      reasons: string[];
      arms: Array<{
        condition: string;
        accepted: boolean;
        reasons: string[];
      }>;
    }>;
  };
}

interface LatestCodingReceipt {
  judging: {
    pairedAcceptance?: PairedJudgingReceipt['pairedAcceptance'];
  };
}

function runPairedAcceptance(input: {
  label: string;
  mode?: CodingPairedFixtureMode;
  mutatePersisted?: (arm: PersistedAcceptanceArm) => void;
  mutateCollection?: (collection: { arms: PersistedAcceptanceArm[] }) => void;
}): {
  collection: { arms: PersistedAcceptanceArm[] };
  receipt: PairedJudgingReceipt;
  latest: LatestCodingReceipt;
  collectionUnchanged: boolean;
  judgeLaunches: number;
  stdout: string;
} {
  const test = createCodingPairedFixture(input.mode);
  createdRoots.push(test.root);
  const runId = 'paired-acceptance-' + input.label + '-' + process.pid;
  const env = {
    ...test.env,
    O8_BENCH_RUN_ID: runId,
    O8_BENCH_LATEST_DIR: path.join(test.root, 'latest'),
  };
  const collect = runCodingPairedCli(test.root, env, ['--paired', '--collect']);
  expect(collect.status, collect.stdout + '\n' + collect.stderr).toBe(0);

  const workRoot = path.join(test.env.TMPDIR!, 'o8-bench-coding', runId);
  const collectionPath = path.join(workRoot, 'collection.json');
  const collection = JSON.parse(
    fs.readFileSync(collectionPath, 'utf8'),
  ) as { arms: PersistedAcceptanceArm[] };
  if (input.mutatePersisted) {
    for (const arm of collection.arms) input.mutatePersisted(arm);
  }
  input.mutateCollection?.(collection);
  if (input.mutatePersisted || input.mutateCollection) {
    fs.writeFileSync(collectionPath, JSON.stringify(collection, null, 2) + '\n');
  }
  const originalCollection = fs.readFileSync(collectionPath);

  const judge = runCodingPairedCli(test.root, env, ['--paired', '--judge']);
  expect(judge.status, judge.stdout + '\n' + judge.stderr).toBe(0);
  const receipt = JSON.parse(
    fs.readFileSync(path.join(workRoot, 'judging.json'), 'utf8'),
  ) as PairedJudgingReceipt;
  const latest = JSON.parse(
    fs.readFileSync(path.join(test.root, 'latest/coding.json'), 'utf8'),
  ) as LatestCodingReceipt;
  const judgeLaunches = codingPairedCommands(test.logPath).filter((call) => (
    call.command === 'ginsu'
      && call.args[0] === 'spawn'
      && call.args[1]?.includes('-judge-')
  )).length;
  return {
    collection,
    receipt,
    latest,
    collectionUnchanged: originalCollection.equals(fs.readFileSync(collectionPath)),
    judgeLaunches,
    stdout: judge.stdout,
  };
}

afterEach(() => {
  for (const root of createdRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('paired coding acceptance through collect and persisted judge processes', () => {
  it.each([
    {
      label: 'worker-failed',
      mode: 'worker-failed' as const,
      reason: 'worker terminal status failed',
    },
    {
      label: 'no-diff',
      mode: 'no-diff' as const,
      reason: 'no diff produced',
    },
    {
      label: 'empty-diff',
      mode: 'empty-diff' as const,
      reason: 'diff artifact is empty',
    },
    {
      label: 'missing-contract',
      mode: 'missing-contract' as const,
      reason: 'treatment contract was not observed',
    },
    {
      label: 'typecheck-failed',
      mode: 'typecheck-failed' as const,
      reason: 'typecheck failed',
    },
    {
      label: 'eslint-failed',
      mode: 'eslint-failed' as const,
      reason: 'touched-file eslint failed',
    },
  ])('persists and excludes $label collection failures', ({ label, mode, reason }) => {
    const result = runPairedAcceptance({ label, mode });

    expect(result.collection.arms).toHaveLength(TASKS.length * 4);
    expect(result.collection.arms.some((arm) => arm.outcome === 'invalid')).toBe(true);
    expect(result.receipt.receipts).toHaveLength(0);
    expect(result.receipt.pairedAcceptance.tasks).toHaveLength(TASKS.length);
    expect(result.receipt.pairedAcceptance.tasks.every((task) => !task.complete)).toBe(true);
    expect(result.receipt.pairedAcceptance.tasks.every((task) => (
      task.reasons.some((entry) => entry.includes(reason))
    ))).toBe(true);
    expect(result.latest.judging.pairedAcceptance).toEqual(result.receipt.pairedAcceptance);
    expect(result.collectionUnchanged).toBe(true);
    expect(result.judgeLaunches).toBe(0);
  }, 180_000);

  it('rejects a persisted contract condition relabelled as raw', () => {
    const result = runPairedAcceptance({
      label: 'contract-condition-labelled-raw',
      mutatePersisted: (arm) => {
        if (arm.condition.endsWith('-contract')) {
          arm.treatment = 'raw';
          arm.contractObserved = false;
          arm.outcome = 'valid';
        }
      },
    });

    expect(result.collection.arms.filter((arm) => arm.condition.endsWith('-contract')).every((arm) => (
      arm.outcome === 'valid' && arm.treatment === 'raw'
    ))).toBe(true);
    expect(result.receipt.receipts).toHaveLength(0);
    expect(result.receipt.pairedAcceptance.tasks.every((task) => (
      task.reasons.some((entry) => entry.includes('condition/treatment mismatch'))
    ))).toBe(true);
    expect(result.latest.judging.pairedAcceptance).toEqual(result.receipt.pairedAcceptance);
    expect(result.collectionUnchanged).toBe(true);
    expect(result.judgeLaunches).toBe(0);
  }, 180_000);

  it('rejects and diagnoses a persisted fifth arm with an unknown condition', () => {
    const unexpectedCondition = 'codex-unknown';
    const result = runPairedAcceptance({
      label: 'unexpected-condition',
      mutateCollection: (collection) => {
        for (const task of TASKS) {
          const knownArm = collection.arms.find((arm) => arm.task === task)!;
          collection.arms.push({
            ...knownArm,
            condition: unexpectedCondition,
          });
        }
      },
    });

    expect(result.collection.arms).toHaveLength(TASKS.length * 5);
    expect(result.receipt.receipts).toHaveLength(0);
    expect(result.receipt.pairedAcceptance.tasks.every((task) => !task.complete)).toBe(true);
    expect(result.receipt.pairedAcceptance.tasks.every((task) => (
      task.reasons.some((reason) => reason.includes(`unexpected condition: ${unexpectedCondition}`))
        && task.arms.some((arm) => (
          arm.condition === unexpectedCondition
            && !arm.accepted
            && arm.reasons.includes(`unexpected condition: ${unexpectedCondition}`)
        ))
    ))).toBe(true);
    expect(result.latest.judging.pairedAcceptance).toEqual(result.receipt.pairedAcceptance);
    expect(result.collectionUnchanged).toBe(true);
    expect(result.judgeLaunches).toBe(0);
  }, 180_000);

  it.each([
    {
      label: 'missing-condition',
      reason: 'arm receipt is missing',
      mutateCollection: (collection: { arms: PersistedAcceptanceArm[] }) => {
        collection.arms = collection.arms.filter((arm) => arm.condition !== 'codex-raw');
      },
    },
    {
      label: 'duplicate-condition',
      reason: 'duplicate arm receipts: 2',
      mutateCollection: (collection: { arms: PersistedAcceptanceArm[] }) => {
        for (const task of TASKS) {
          const knownArm = collection.arms.find((arm) => (
            arm.task === task && arm.condition === 'codex-raw'
          ))!;
          collection.arms.push({ ...knownArm });
        }
      },
    },
  ])('keeps $label task cardinality rejection', ({ label, reason, mutateCollection }) => {
    const result = runPairedAcceptance({ label, mutateCollection });

    expect(result.receipt.receipts).toHaveLength(0);
    expect(result.receipt.pairedAcceptance.tasks.every((task) => !task.complete)).toBe(true);
    expect(result.receipt.pairedAcceptance.tasks.every((task) => (
      task.reasons.some((entry) => entry.includes(reason))
    ))).toBe(true);
    expect(result.collectionUnchanged).toBe(true);
    expect(result.judgeLaunches).toBe(0);
  }, 180_000);

  it('judges a complete valid set with genuine diffs, contracts, pins, and owned dependencies', () => {
    const result = runPairedAcceptance({ label: 'valid' });
    const contractArms = result.collection.arms.filter((arm) => arm.condition.endsWith('-contract'));
    const rawArms = result.collection.arms.filter((arm) => arm.condition.endsWith('-raw'));

    expect(result.collection.arms.every((arm) => arm.outcome === 'valid')).toBe(true);
    expect(result.collection.arms.every((arm) => (
      arm.requestedSettings.model === codingPairedRuntimeConfig.arms[arm.runtime].model
        && arm.requestedSettings.effort === codingPairedRuntimeConfig.arms[arm.runtime].effort
    ))).toBe(true);
    expect(result.collection.arms.every((arm) => (
      arm.dependencies.owned
        && !arm.dependencies.symbolicLink
        && !fs.lstatSync(arm.dependencies.destination).isSymbolicLink()
    ))).toBe(true);
    expect(result.collection.arms.every((arm) => (
      fs.readFileSync(arm.diffPath, 'utf8').trim().length > 0
    ))).toBe(true);
    expect(contractArms.every((arm) => arm.contractObserved === true)).toBe(true);
    expect(rawArms.every((arm) => arm.contractObserved === null)).toBe(true);
    expect(result.receipt.pairedAcceptance.tasks.every((task) => task.complete)).toBe(true);
    expect(result.latest.judging.pairedAcceptance).toEqual(result.receipt.pairedAcceptance);
    expect(result.collectionUnchanged).toBe(true);
    expect(result.receipt.receipts).toHaveLength(TASKS.length * 2);
    expect(result.judgeLaunches).toBe(TASKS.length * 2);
    expect(result.stdout).toContain('[coding] complete tasks scored: 3');
    expect(codingPairedRuntimeConfig.arms.codex.model).toBe('test/codex-arm');
  }, 180_000);
});
