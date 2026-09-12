import fs from 'node:fs';
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
  for (const root of createdRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('coding benchmark runtime configuration through the process entry point', () => {
  it('rejects missing and malformed configuration before inspecting the launcher', () => {
    const test = createFixture();
    const missingEnv = { ...test.env };
    delete missingEnv.O8_BENCH_RUNTIME_CONFIG;
    const missing = runCodingPairedCli(
      test.root,
      { ...missingEnv, O8_BENCH_RUN_ID: 'missing-runtime-config' },
      ['--paired', '--preflight'],
    );
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('O8_BENCH_RUNTIME_CONFIG');

    const malformedPath = path.join(test.root, 'malformed.json');
    fs.writeFileSync(malformedPath, '{"schema":');
    const malformed = runCodingPairedCli(
      test.root,
      {
        ...test.env,
        O8_BENCH_RUN_ID: 'malformed-runtime-config',
        O8_BENCH_RUNTIME_CONFIG: malformedPath,
      },
      ['--paired', '--preflight'],
    );
    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr).toContain('invalid coding runtime config');
    expect(fs.existsSync(test.logPath)).toBe(false);
  });

  it('passes pinned settings through paired collection and persisted judging receipts', () => {
    const test = createFixture();
    const runId = 'runtime-config-' + process.pid + '-' + Date.now();
    const env = { ...test.env, O8_BENCH_RUN_ID: runId };
    const collect = runCodingPairedCli(test.root, env, ['--paired', '--collect']);
    expect(collect.status, collect.stdout + '\n' + collect.stderr).toBe(0);

    const runRoot = path.join(test.env.TMPDIR!, 'o8-bench-coding', runId);
    const collection = JSON.parse(fs.readFileSync(path.join(runRoot, 'collection.json'), 'utf8')) as {
      requestedSettings?: typeof codingPairedRuntimeConfig;
      arms: Array<{
        runtime: 'codex' | 'claude';
        worker: string;
        outcome: string;
        requestedSettings?: { model: string; effort: string };
        dependencies: { destination: string; owned: boolean; symbolicLink: boolean };
        spawn: { command: string };
      }>;
    };
    expect(collection.requestedSettings).toEqual(codingPairedRuntimeConfig);
    expect(collection.arms).toHaveLength(12);
    for (const arm of collection.arms) {
      expect(arm.outcome).toBe('valid');
      expect(arm.requestedSettings).toEqual(codingPairedRuntimeConfig.arms[arm.runtime]);
      expect(arm.spawn.command).toContain('--model ' + arm.requestedSettings?.model);
      expect(arm.spawn.command).toContain('--effort ' + arm.requestedSettings?.effort);
      expect(arm.dependencies).toMatchObject({ owned: true, symbolicLink: false });
      expect(fs.lstatSync(arm.dependencies.destination).isSymbolicLink()).toBe(false);
    }

    const armWorkers = new Set(collection.arms.map((arm) => arm.worker));
    const armLaunches = codingPairedCommands(test.logPath).filter((call) => (
      call.command === 'ginsu' && call.args[0] === 'spawn' && armWorkers.has(call.args[1])
    ));
    expect(armLaunches).toHaveLength(12);
    for (const { args } of armLaunches) {
      const runtime = args[args.indexOf('--engine') + 1] as 'codex' | 'claude';
      expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2))
        .toEqual(['--model', codingPairedRuntimeConfig.arms[runtime].model]);
      expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2))
        .toEqual(['--effort', codingPairedRuntimeConfig.arms[runtime].effort]);
    }
    const armPrompts = codingPairedCommands(test.logPath).filter((call) => (
      call.command === 'ginsu' && call.args[0] === 'send' && armWorkers.has(call.args[1])
    ));
    expect(armPrompts).toHaveLength(12);
    for (const { args } of armPrompts) {
      expect(args[2]).toContain('Work alone for this benchmark.');
      expect(args[2]).toContain('Do not launch helper agents, delegate work, or make');
      expect(args[2]).toContain('additional model calls.');
    }

    const judge = runCodingPairedCli(test.root, env, ['--paired', '--judge']);
    expect(judge.status, judge.stdout + '\n' + judge.stderr).toBe(0);
    const judging = JSON.parse(fs.readFileSync(path.join(runRoot, 'judging.json'), 'utf8')) as {
      requestedSettings?: typeof codingPairedRuntimeConfig.judges;
      receipts: Array<{
        judge: 'codex' | 'claude';
        worker: string;
        promptPath: string;
        requestedSettings?: { model: string; effort: string };
        dependencies: { destination: string; owned: boolean; symbolicLink: boolean };
        spawn: { command: string };
      }>;
    };
    expect(judging.requestedSettings).toEqual(codingPairedRuntimeConfig.judges);
    expect(judging.receipts).toHaveLength(6);
    for (const receipt of judging.receipts) {
      expect(receipt.requestedSettings).toEqual(codingPairedRuntimeConfig.judges[receipt.judge]);
      const prompt = fs.readFileSync(receipt.promptPath, 'utf8');
      expect(prompt).toContain('Work alone for this benchmark.');
      expect(prompt).toContain('Do not launch helper agents, delegate work, or make');
      expect(prompt).toContain('additional model calls.');
      expect(receipt.spawn.command).toContain('--model ' + receipt.requestedSettings?.model);
      expect(receipt.spawn.command).toContain('--effort ' + receipt.requestedSettings?.effort);
      expect(receipt.dependencies).toMatchObject({ owned: true, symbolicLink: false });
      expect(fs.lstatSync(receipt.dependencies.destination).isSymbolicLink()).toBe(false);
    }
    const judgeWorkers = new Set(judging.receipts.map((receipt) => receipt.worker));
    const judgeLaunches = codingPairedCommands(test.logPath).filter((call) => (
      call.command === 'ginsu' && call.args[0] === 'spawn' && judgeWorkers.has(call.args[1])
    ));
    expect(judgeLaunches).toHaveLength(6);
    for (const { args } of judgeLaunches) {
      const runtime = args[args.indexOf('--engine') + 1] as 'codex' | 'claude';
      expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2))
        .toEqual(['--model', codingPairedRuntimeConfig.judges[runtime].model]);
      expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2))
        .toEqual(['--effort', codingPairedRuntimeConfig.judges[runtime].effort]);
    }
  }, 180_000);
});
