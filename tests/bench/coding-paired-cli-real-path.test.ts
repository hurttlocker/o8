import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  codingPairedCommands,
  codingPairedRuntimeConfig,
  createCodingPairedFixture,
  runCodingPairedCli,
} from './coding-paired-process-fixture';

const createdRoots: string[] = [];

function createFixture() {
  const fixture = createCodingPairedFixture();
  createdRoots.push(fixture.root);
  return fixture;
}

afterEach(() => {
  for (const root of createdRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('paired-only coding benchmark CLI', () => {
  it('isolates formerly colliding run IDs without a live app or control-plane command', () => {
    const test = createFixture();
    const workersByRun = new Map<string, string[]>();
    for (const runId of ['run.a', 'run_a']) {
      const env = { ...test.env, O8_BENCH_RUN_ID: runId };
      for (const args of [['--paired', '--preflight'], ['--paired', '--collect'], ['--paired', '--judge']]) {
        const result = runCodingPairedCli(test.root, env, args);
        expect(result.status, `${runId} ${args.join(' ')}\n${result.stderr}`).toBe(0);
      }

      const workRoot = path.join(test.env.TMPDIR!, 'o8-bench-coding', runId);
      const collection = JSON.parse(readFileSync(path.join(workRoot, 'collection.json'), 'utf8'));
      const judging = JSON.parse(readFileSync(path.join(workRoot, 'judging.json'), 'utf8'));
      const workers = [
        ...collection.arms.map((arm: { worker: string }) => arm.worker),
        ...judging.receipts.map((receipt: { worker: string }) => receipt.worker),
      ];
      workersByRun.set(runId, workers);

      expect(collection).toMatchObject({
        phase: 'paired-only',
        requestedSettings: codingPairedRuntimeConfig,
        arms: { length: 12 },
        endToEnd: { status: 'not-collected' },
        runControl: { status: 'completed', completedArms: 12, backendProbe: null },
      });
      expect(judging.receipts).toHaveLength(6);
      for (const arm of collection.arms) {
        expect(arm.requestedSettings).toEqual(codingPairedRuntimeConfig.arms[arm.runtime as 'codex' | 'claude']);
        expect(arm.spawn.command).toContain(`--model ${arm.requestedSettings.model}`);
        expect(arm.spawn.command).toContain(`--effort ${arm.requestedSettings.effort}`);
      }
      for (const receipt of judging.receipts) {
        expect(receipt.requestedSettings)
          .toEqual(codingPairedRuntimeConfig.judges[receipt.judge as 'codex' | 'claude']);
        expect(receipt.spawn.command).toContain(`--model ${receipt.requestedSettings.model}`);
        expect(receipt.spawn.command).toContain(`--effort ${receipt.requestedSettings.effort}`);
      }
      expect(collection.arms.every((arm: { worktree: string }) => (
        !lstatSync(path.join(arm.worktree, 'node_modules')).isSymbolicLink()
      ))).toBe(true);
    }

    const result = JSON.parse(readFileSync(path.join(test.root, 'tests/bench/latest/coding.json'), 'utf8'));
    const calls = codingPairedCommands(test.logPath);
    const ginsuNames = calls
      .filter((call) => call.command === 'ginsu' && call.args[0] === 'spawn')
      .map((call) => call.args[1]);
    expect(result.endToEnd).toMatchObject({ status: 'not-collected' });
    expect(calls.some((call) => call.command === 'o8')).toBe(false);
    expect(readdirSync(test.dataDir)).toEqual([]);
    expect(ginsuNames).toHaveLength(36);
    expect(new Set(ginsuNames).size).toBe(36);
    expect(workersByRun.get('run.a')).toHaveLength(18);
    expect(workersByRun.get('run_a')).toHaveLength(18);
    expect(workersByRun.get('run.a')).not.toEqual(workersByRun.get('run_a'));
    expect(ginsuNames.every((name) => /^bc-run-a-[a-f0-9]{16}-(?:arm|judge)-/.test(name))).toBe(true);
  }, 180_000);

  it('requires paired runtime configuration before any launcher or app action', () => {
    const test = createFixture();
    const env = { ...test.env };
    delete env.O8_BENCH_RUNTIME_CONFIG;
    for (const [index, args] of [
      ['--paired', '--preflight'],
      ['--paired', '--collect'],
      ['--paired', '--judge'],
      ['--paired', '--all'],
    ].entries()) {
      const result = runCodingPairedCli(test.root, {
        ...env,
        O8_BENCH_RUN_ID: `missing-config-${index}`,
      }, args);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('O8_BENCH_RUNTIME_CONFIG');
    }
    expect(existsSync(test.logPath)).toBe(false);
    expect(readdirSync(test.dataDir)).toEqual([]);
  });

  it('keeps the legacy full preflight connected to e2e control', () => {
    const test = createFixture();
    const preflight = runCodingPairedCli(test.root, { ...test.env, O8_BENCH_RUN_ID: 'legacy-preflight' }, ['--preflight']);
    expect(preflight.status, preflight.stderr).toBe(0);
    expect(codingPairedCommands(test.logPath).some((call) => call.command === 'o8')).toBe(true);
  });
});
