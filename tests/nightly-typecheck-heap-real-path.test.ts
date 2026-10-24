import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(readFileSync(resolve('.github/workflows/nightly.yml'), 'utf8'));
const step = workflow.jobs.verify.steps.find((candidate: { name?: string }) => (
  candidate.name === 'Check protocol, types, and test classification'
));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runStep(failProtocol = false) {
  const root = mkdtempSync(join(tmpdir(), 'o8-nightly-heap-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: Object.fromEntries(['protocol:check', 'typecheck', 'test:classification:check']
      .map(name => [name, `node check.cjs ${name}`])),
  }));
  writeFileSync(join(root, 'check.cjs'), `
    const { appendFileSync } = require('node:fs');
    const heapMiB = require('node:v8').getHeapStatistics().heap_size_limit / 1024 / 1024;
    appendFileSync('receipt.jsonl', JSON.stringify({ command: process.argv[2], heapMiB }) + '\\n');
    if (process.argv[2] === 'protocol:check' && process.env.FAIL_PROTOCOL === '1') process.exit(42);
    if (heapMiB < 8192) process.exit(86);
  `);
  const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: '', ...workflow.env, ...workflow.jobs.verify.env,
      ...step.env, FAIL_PROTOCOL: failProtocol ? '1' : '0' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  const receipts = readFileSync(join(root, 'receipt.jsonl'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as { command: string; heapMiB: number });
  return { result, receipts };
}

describe('nightly type-check step runtime', () => {
  it('passes an explicit 8 GiB heap budget to every verification command', () => {
    const { result, receipts } = runStep();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(receipts.map(receipt => receipt.command)).toEqual([
      'protocol:check', 'typecheck', 'test:classification:check',
    ]);
    for (const receipt of receipts) expect(receipt.heapMiB).toBeGreaterThanOrEqual(8192);
  });

  it('still stops at the first failed verification command', () => {
    const { result, receipts } = runStep(true);
    expect(result.status, result.stderr || result.stdout).toBe(42);
    expect(receipts.map(receipt => receipt.command)).toEqual(['protocol:check']);
  });
});
