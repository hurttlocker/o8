import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// #3414: the merge gate is the host's own code. A packet that edits the gate
// file must never get its copy executed, and must never grade itself.
const root = mkdtempSync(path.join(tmpdir(), 'o8-merge-gate-host-'));
process.env.CORTEX_IDE_DATA_DIR = path.join(root, 'data');
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;
const { createLane } = await import('@/lib/lane/registry');
const { runMergeGate } = await import('@/lib/lane/merge-gate');
const { closeDb } = await import('@/lib/db');

function git(cwd: string, args: string[]): string {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

describe('merge gate runs only host code (#3414)', () => {
  it('never executes a packet copy of the gate and requires a person to approve it', async () => {
    const repoPath = path.join(root, 'repo');
    const worktreePath = path.join(root, 'lane');
    const marker = path.join(root, 'packet-gate-ran');
    mkdirSync(path.join(repoPath, 'src', 'lib', 'lane'), { recursive: true });
    mkdirSync(path.join(repoPath, 'scripts'), { recursive: true });
    git(repoPath, ['init', '-q', '-b', 'main']);
    git(repoPath, ['config', 'user.name', 'Test Author']);
    git(repoPath, ['config', 'user.email', 'test@example.test']);
    writeFileSync(path.join(repoPath, 'src', 'lib', 'lane', 'merge-gate.ts'), 'export const gate = 1;\n');
    writeFileSync(path.join(repoPath, 'scripts', 'register-server-only-stub.mjs'), 'export {};\n');
    writeFileSync(path.join(repoPath, '.gitignore'), 'node_modules\n');
    git(repoPath, ['add', '.']);
    git(repoPath, ['commit', '-qm', 'base']);
    const baseCommit = git(repoPath, ['rev-parse', 'HEAD']);
    git(repoPath, ['worktree', 'add', '-q', '-b', 'packet/gate', worktreePath]);
    // Lanes get the repo's dependencies, so a packet gate could load its toolchain.
    symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(worktreePath, 'node_modules'), 'dir');
    writeFileSync(path.join(worktreePath, 'src', 'lib', 'lane', 'merge-gate.ts'), [
      "import { writeFileSync } from 'node:fs';",
      'export async function runMergeGate() {',
      `  writeFileSync(${JSON.stringify(marker)}, 'ran');`,
      '  return { passed: true, violations: [] };',
      '}',
      '',
    ].join('\n'));
    git(worktreePath, ['add', 'src']);
    git(worktreePath, ['commit', '-qm', 'packet edits the gate']);
    const lane = createLane({ repoPath, worktreePath, branch: 'packet/gate', baseBranch: 'main', baseCommit,
      runtime: 'codex', packetId: 'gate-self-update' });

    const result = await runMergeGate(lane, undefined, true);

    expect(existsSync(marker)).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(expect.objectContaining({
      category: 'integrity', severity: 'block', label: 'Packet changes the merge gate', file: 'src/lib/lane/merge-gate.ts',
    }));
  }, 120_000);
});
