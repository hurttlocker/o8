#!/usr/bin/env node
// Run with --import ./scripts/register-server-only-stub.mjs --import tsx.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import materialization from '../../src/lib/worktree/materialization-execution.ts';
import { root, distribution, round, writeJson } from './common.mjs';
import { fixture } from './stack.mjs';

const parent = path.join(root, 'tmp/speed-evidence/guard-cost');
const { guardedWorkspaceInvocation } = materialization;
fs.mkdirSync(parent, { recursive: true });
const seeded = fixture(parent, 1);
const cwd = fs.realpathSync(seeded.repoDir);
const stat = fs.lstatSync(cwd);
const identity = { canonicalPath: cwd, device: stat.dev, inode: stat.ino };
const guarded = guardedWorkspaceInvocation('git', ['status', '--porcelain'], identity);
const samples = [];
for (let sample = 0; sample < 3; sample++) {
  const reading = { sample: sample + 1, directMs: [], guardedMs: [] };
  for (let i = 0; i < 20; i++) for (const mode of i % 2 ? ['guarded', 'direct'] : ['direct', 'guarded']) {
    const started = performance.now();
    const stdout = execFileSync(mode === 'guarded' ? guarded.command : 'git', mode === 'guarded' ? guarded.args : ['status', '--porcelain'], { cwd, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    if (stdout !== '') throw new Error('Fixture Git status changed');
    reading[`${mode}Ms`].push(round(performance.now() - started));
  }
  samples.push({ sample: reading.sample, directMs: distribution(reading.directMs), guardedMs: distribution(reading.guardedMs) });
}
const receipt = { schema: 'o8/speed-guard-cost/v1', repetitions: 3, callsPerArmPerRepetition: 20,
  workload: 'The production guardedWorkspaceInvocation and direct git status, alternating on the same tiny local repository. Empty output is checked.',
  samples, directMs: distribution(samples.flatMap(row => row.directMs.samples)), guardedMs: distribution(samples.flatMap(row => row.guardedMs.samples)) };
writeJson(path.join(root, 'tmp/speed-evidence/guard-cost.json'), receipt);
process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
