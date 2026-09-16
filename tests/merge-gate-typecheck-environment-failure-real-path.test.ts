import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const { runLaneRebaseTypecheck } = await import('@/lib/lane/rebase-typecheck');

const created: string[] = [];

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/**
 * A worktree that passes `detectTypecheckSkip` (it has a tsconfig and a local
 * compiler) whose compiler behaves however the test needs. `npx` resolves the
 * local `node_modules/.bin/tsc` first, so the gate really executes this script.
 */
function worktreeWithCompiler(script: string): string {
  const cwd = mkdtempSync(join(os.tmpdir(), 'o8-merge-gate-typecheck-'));
  created.push(cwd);
  writeFileSync(
    join(cwd, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { noEmit: true } }),
    'utf8',
  );
  const bin = join(cwd, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  const tsc = join(bin, 'tsc');
  writeFileSync(tsc, script, 'utf8');
  chmodSync(tsc, 0o755);
  return cwd;
}

const branch = 'inline/96241-docs-only';

describe('merge gate typecheck, environment failure', () => {
  it('does not call a silent non-zero exit a type error', async () => {
    // Nothing on either stream: a timeout kill, or a worktree whose contents
    // were not ready. The merge should continue with the check marked skipped.
    const cwd = worktreeWithCompiler('#!/bin/sh\nexit 1\n');

    const result = await runLaneRebaseTypecheck({ cwd, actualBranch: branch, logPrefix: 'lane-merge' });

    expect(result.ok).toBe(true);
    expect(result.ok && result.skipped).toMatch(/did not run to completion/);
  });

  it('still fails the merge when the compiler reports a real diagnostic', async () => {
    const cwd = worktreeWithCompiler(
      "#!/bin/sh\necho \"src/a.ts(1,1): error TS2304: Cannot find name 'nope'.\"\nexit 2\n",
    );

    const result = await runLaneRebaseTypecheck({ cwd, actualBranch: branch, logPrefix: 'lane-merge' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.output).toContain('error TS2304');
  });

  it('still fails the merge when the compiler crashes without emitting a diagnostic', async () => {
    // A compiler that dies on the diff's own types writes a stack trace and no
    // `error TS` line. That has to keep blocking the merge and keep carrying
    // its evidence, or a real failure merges with less information than before.
    const cwd = worktreeWithCompiler(
      '#!/bin/sh\necho "RangeError: Maximum call stack size exceeded" 1>&2\nexit 7\n',
    );

    const result = await runLaneRebaseTypecheck({ cwd, actualBranch: branch, logPrefix: 'lane-merge' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.output).toContain('Maximum call stack size exceeded');
  });
});
