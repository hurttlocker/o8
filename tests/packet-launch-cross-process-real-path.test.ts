import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error('Timed out waiting for child launch state.'));
      setTimeout(poll, 20);
    };
    poll();
  });
}

describe('packet launch exclusive cross-process claim', () => {
  it('allows one production dispatch launch across two processes for one reservation generation', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'o8-launch-claim-processes-'));
    const repo = path.join(root, 'repo');
    const counter = path.join(root, 'launches');
    const gate = path.join(root, 'release');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    writeFileSync(path.join(repo, 'README.md'), 'base\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-q', '-m', 'base'], { cwd: repo });
    const run = (index: number) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        './node_modules/vitest/vitest.mjs', 'run',
        'tests/fixtures/packet-launch-cross-process-child.test.ts', '--reporter=dot',
      ], {
        cwd: path.resolve('.'),
        env: {
          ...process.env,
          CORTEX_IDE_DATA_DIR: path.join(root, 'data'),
          O8_TEST_DATA_DIR_PINNED: path.join(root, 'data'),
          O8_TEST_LAUNCH_REPO: repo,
          O8_TEST_LAUNCH_COUNTER: counter,
          O8_TEST_LAUNCH_GATE: gate,
          O8_TEST_LAUNCH_RESULT: path.join(root, `result-${index}`),
        },
        stdio: 'pipe',
      });
      let output = '';
      child.stdout.on('data', (chunk) => { output += String(chunk); });
      child.stderr.on('data', (chunk) => { output += String(chunk); });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(output)));
    });
    const first = run(1);
    await waitFor(() => existsSync(counter) && readFileSync(counter, 'utf8').trim().split('\n').length === 1);
    const second = run(2);
    await waitFor(() => existsSync(path.join(root, 'result-2')) || existsSync(path.join(root, 'result-1')));
    writeFileSync(gate, 'release');
    await Promise.all([first, second]);

    expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
    expect([
      readFileSync(path.join(root, 'result-1'), 'utf8'),
      readFileSync(path.join(root, 'result-2'), 'utf8'),
    ].sort()).toEqual(['held', 'launched']);
  }, 60_000);
});
