import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, expect, it, vi } from 'vitest';

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-read-startup-')));
const previousNodeOptions = process.env.NODE_OPTIONS;
process.env.O8_DATA_DIR = path.join(root, 'data');
process.env.CORTEX_IDE_DATA_DIR = process.env.O8_DATA_DIR;
process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');
delete process.env.O8_SKIP_PRELAUNCH_TYPECHECK;

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const,
    probePath: root,
    availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000,
    error: null,
  })),
}));

const { closeDb } = await import('@/lib/db');
const { prepareLaunchWorktree } = await import('@/lib/worktree/launch');
const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
const { inspectPinnedWorkspaceEntry, readPinnedWorkspaceFile } = await import('@/lib/worktree/materialization-leaf-io');

afterAll(() => {
  if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = previousNodeOptions;
  delete process.env.O8_TEST_STARTUP_LOG;
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

it('starts Node once per pinned read or inspection through worktree launch', async () => {
  const repoRoot = path.join(root, 'repo');
  mkdirSync(repoRoot);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  writeFileSync(path.join(repoRoot, 'README.md'), 'tracked fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
  execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'base'], { cwd: repoRoot });

  const log = path.join(root, 'startups.jsonl');
  const preload = path.join(root, 'count-startups.cjs');
  writeFileSync(preload, `
const operation = process.argv.slice(1).find(arg => arg === 'read' || arg === 'inspect-entry');
if (operation) require('node:fs').appendFileSync(process.env.O8_TEST_STARTUP_LOG,
  JSON.stringify({ pid: process.pid, operation }) + '\\n');
`);
  process.env.O8_TEST_STARTUP_LOG = log;
  process.env.NODE_OPTIONS = `${previousNodeOptions ?? ''} --require=${preload}`.trim();
  const launch = await prepareLaunchWorktree({
    repoRoot,
    agentType: 'codex',
    taskName: 'pinned read startup',
    branchName: 'fixture/pinned-read-startup',
    baseBranch: 'main',
    isolate: true,
    isolationPreference: 'git-worktree',
    skipSetup: true,
  });
  expect(launch?.worktree.status).toBe('ready');
  expect(readFileSync(path.join(launch!.cwd, 'README.md'), 'utf8')).toBe('tracked fixture\n');
  const metadata = JSON.parse(readFileSync(path.join(path.dirname(launch!.cwd), '.meta.json'), 'utf8'));
  expect(metadata.worktrees[launch!.worktree.id]?.materializationIdentity?.canonicalPath).toBe(launch?.cwd);

  const receipts = readFileSync(log, 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as { pid: number; operation: string });
  expect(new Set(receipts.map(receipt => receipt.operation))).toEqual(new Set(['read', 'inspect-entry']));
  const startupCounts = new Map<number, number>();
  for (const receipt of receipts) startupCounts.set(receipt.pid, (startupCounts.get(receipt.pid) ?? 0) + 1);
  expect([...startupCounts.values()]).toEqual(Array(startupCounts.size).fill(1));
}, 30_000);

it.each(['read', 'inspect-entry'] as const)('refuses a replaced workspace before %s accesses it', async (operation) => {
  const workspace = path.join(root, `replacement-${operation}`);
  mkdirSync(workspace);
  const identity = await captureWorktreeMaterializationIdentity(workspace);
  renameSync(workspace, `${workspace}-admitted`);
  mkdirSync(workspace);
  writeFileSync(path.join(workspace, 'sentinel'), 'external bytes');

  const access = operation === 'read' ? readPinnedWorkspaceFile : inspectPinnedWorkspaceEntry;
  await expect(access(workspace, identity, 'sentinel'))
    .rejects.toThrow('Managed workspace ownership changed before process execution.');
  expect(readFileSync(path.join(workspace, 'sentinel'), 'utf8')).toBe('external bytes');
});
