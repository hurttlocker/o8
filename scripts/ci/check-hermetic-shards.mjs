#!/usr/bin/env node
// Discover files through the same Vitest entry point as test:unit. The shard
// arguments and matrix come from CI, rather than a second sharding algorithm.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { createVitest, parseCLI } from 'vitest/node';
import { parse } from 'yaml';

const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const job = workflow.jobs['test-shards'];
assert(job, 'CI must define hermetic shard jobs');
const command = job.steps.find((step) => step.run?.startsWith('npm run test:unit -- '))?.run;
assert(command, 'CI must shard the existing test:unit entry point');
const unit = JSON.parse(readFileSync('package.json', 'utf8')).scripts['test:unit'];
assert(unit.startsWith('vitest run '), 'Expected the Vitest test:unit entry point');

async function list(extra = '') {
  const { options } = parseCLI(`${unit} ${extra}`);
  const ctx = await createVitest('test', { ...options, watch: false });
  try {
    let specs = await ctx.globTestSpecifications();
    // Vitest list --filesOnly ignores --shard. Use the configured sequencer
    // that Vitest's execution pool invokes, without importing any test files.
    if (ctx.config.shard) {
      const sequencer = new ctx.config.sequence.sequencer(ctx);
      specs = await sequencer.shard([...specs]);
    }
    return specs.map((spec) => relative(process.cwd(), spec.moduleId)).sort();
  } finally {
    await ctx.close();
  }
}

const files = await list();
assert(files.length > 0, 'Hermetic discovery must not be empty');
const all = [];
for (const shard of job.strategy.matrix.shard) {
  const extra = command.slice('npm run test:unit -- '.length)
    .replaceAll('${{ matrix.shard }}', String(shard)).trim();
  assert(extra.includes('--shard='), 'CI must supply a Vitest shard');
  const selected = await list(extra);
  assert(selected.length > 0, `Shard ${shard} must not be empty`);
  console.log(`[hermetic-shards] shard ${shard}: ${selected.length} files`);
  all.push(...selected);
}
const union = new Set(all);
const expected = new Set(files);
const missing = files.filter((file) => !union.has(file));
const extra = [...union].filter((file) => !expected.has(file));
const duplicates = all.length - union.size;
console.log(`[hermetic-shards] ${files.length} files, ${job.strategy.matrix.shard.length} shards, ${missing.length} missing, ${duplicates} duplicates, ${extra.length} extra`);
assert.deepEqual(missing, []);
assert.deepEqual(extra, []);
assert.equal(duplicates, 0);
