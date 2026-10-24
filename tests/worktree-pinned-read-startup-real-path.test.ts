import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, linkSync, writeFileSync } from 'node:fs';
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
const { withPinnedWorkspaceReadSession } = await import('@/lib/worktree/materialization-read-session');
const { inspectPinnedWorkspaceEntry, readPinnedWorkspaceFile } = await import('@/lib/worktree/materialization-leaf-io');

afterAll(() => {
  if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = previousNodeOptions;
  delete process.env.O8_TEST_STARTUP_LOG;
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

it('batches distinct pinned reads and inspections into one helper through worktree launch', async () => {
  const repoRoot = path.join(root, 'repo');
  mkdirSync(repoRoot);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  writeFileSync(path.join(repoRoot, 'README.md'), 'tracked fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
  execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'base'], { cwd: repoRoot });

  const log = path.join(root, 'startups.jsonl');
  const preload = path.join(root, 'count-startups.cjs');
  writeFileSync(preload, `
const operation = process.argv.slice(1).find(arg => arg === 'read' || arg === 'inspect-entry' || arg === 'pinned-read-session' || arg === 'atomic-write' || arg === 'ensure-directory' || arg === 'ensure-file');
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
  const reads = receipts.filter(receipt => ['read', 'inspect-entry', 'pinned-read-session'].includes(receipt.operation));
  const mutations = receipts.filter(receipt => !reads.includes(receipt));
  const mutationStarts = new Map<number, number>();
  for (const receipt of mutations) mutationStarts.set(receipt.pid, (mutationStarts.get(receipt.pid) ?? 0) + 1);
  process.stdout.write(`[pinned-mutation-startups] ${JSON.stringify([...mutationStarts.values()])}\n`);
  expect([...mutationStarts.values()]).toEqual(Array(mutationStarts.size).fill(1));
  expect(reads.length).toBeGreaterThan(0);
  process.stdout.write(`[pinned-read-launch-startups] ${reads.length}\n`);
  expect(reads).toHaveLength(1);
  const startupCounts = new Map<number, number>();
  for (const receipt of reads) startupCounts.set(receipt.pid, (startupCounts.get(receipt.pid) ?? 0) + 1);
  expect([...startupCounts.values()]).toEqual(Array(startupCounts.size).fill(1));
  for (const pid of startupCounts.keys()) expect(() => process.kill(pid, 0)).toThrow();
}, 120_000);

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


it.each(['read', 'inspect-entry'] as const)('revalidates ownership between batched %s requests', async (operation) => {
  const workspace = path.join(root, `session-replacement-${operation}`);
  mkdirSync(workspace);
  writeFileSync(path.join(workspace, 'sentinel'), 'admitted bytes');
  const identity = await captureWorktreeMaterializationIdentity(workspace);
  await withPinnedWorkspaceReadSession(async () => {
    expect(await readPinnedWorkspaceFile(workspace, identity, 'sentinel')).toBe('admitted bytes');
    renameSync(workspace, `${workspace}-admitted`);
    mkdirSync(workspace);
    writeFileSync(path.join(workspace, 'sentinel'), 'replacement bytes');
    const access = operation === 'read' ? readPinnedWorkspaceFile : inspectPinnedWorkspaceEntry;
    await expect(access(workspace, identity, 'sentinel'))
      .rejects.toThrow('Managed workspace ownership changed before process execution.');
  });
  expect(readFileSync(path.join(workspace, 'sentinel'), 'utf8')).toBe('replacement bytes');
});

it('rereads contents and re-enters each root after a descendant read', async () => {
  const first = path.join(root, 'session-first');
  const second = path.join(root, 'session-second');
  mkdirSync(path.join(first, 'nested'), { recursive: true });
  mkdirSync(second);
  writeFileSync(path.join(first, 'nested/file'), 'first');
  writeFileSync(path.join(second, 'file'), 'second');
  const firstIdentity = await captureWorktreeMaterializationIdentity(first);
  const secondIdentity = await captureWorktreeMaterializationIdentity(second);
  await withPinnedWorkspaceReadSession(async () => {
    expect(await readPinnedWorkspaceFile(first, firstIdentity, 'nested/file')).toBe('first');
    expect(await readPinnedWorkspaceFile(second, secondIdentity, 'file')).toBe('second');
    writeFileSync(path.join(first, 'nested/file'), 'updated');
    expect(await readPinnedWorkspaceFile(first, firstIdentity, 'nested/file')).toBe('updated');
    symlinkSync(second, path.join(first, 'linked'));
    await expect(readPinnedWorkspaceFile(first, firstIdentity, 'linked/file')).rejects.toThrow('unsafe ancestor');
    linkSync(path.join(second, 'file'), path.join(first, 'hardlink'));
    await expect(readPinnedWorkspaceFile(first, firstIdentity, 'hardlink')).rejects.toThrow('exclusive regular file');
    expect(await readPinnedWorkspaceFile(first, firstIdentity, 'missing')).toBeNull();
  });
});

it('guards each batched Git read and leaves Git writes on the existing runner', async () => {
  const { materializationAwareExecFile, withWorktreeMaterializationExecution } = await import('@/lib/worktree/materialization-execution');
  const workspace = path.join(root, 'session-git');
  mkdirSync(workspace);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
  const identity = await captureWorktreeMaterializationIdentity(workspace);
  await withPinnedWorkspaceReadSession(() => withWorktreeMaterializationExecution(workspace, identity, async () => {
    const run = (args: string[]) => materializationAwareExecFile('git', args, { cwd: workspace, timeout: 5_000 });
    expect((await run(['branch', '--show-current'])).stdout.trim()).toBe('main');
    await run(['checkout', '-qb', 'fixture/changed']);
    expect((await run(['branch', '--show-current'])).stdout.trim()).toBe('fixture/changed');
    renameSync(workspace, `${workspace}-admitted`);
    mkdirSync(workspace);
    await expect(run(['branch', '--show-current'])).rejects.toThrow('Managed workspace ownership changed before process execution.');
  }));
});

it('uses a fresh runner for background reads inherited after the session closes', async () => {
  const workspace = path.join(root, 'session-background');
  mkdirSync(workspace);
  writeFileSync(path.join(workspace, 'file'), 'before');
  const identity = await captureWorktreeMaterializationIdentity(workspace);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let background!: Promise<string | null>;
  await withPinnedWorkspaceReadSession(async () => {
    expect(await readPinnedWorkspaceFile(workspace, identity, 'file')).toBe('before');
    background = (async () => { await gate; return readPinnedWorkspaceFile(workspace, identity, 'file'); })();
  });
  writeFileSync(path.join(workspace, 'file'), 'after');
  release();
  expect(await background).toBe('after');
});


it('filters saved credentials from the batched reader while preserving unrelated service keys', async () => {
  const { mutateProviderKey } = await import('@/lib/providers/key-store');
  const names = ['NODE_OPTIONS', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'O8_MASTER_KEY', 'BRAVE_API_KEY'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const workspace = path.join(root, 'session-credentials');
  const receipt = path.join(root, 'reader-credentials.json');
  const preload = path.join(root, 'reader-credentials.cjs');
  mkdirSync(workspace);
  writeFileSync(path.join(workspace, 'file'), 'pinned contents');
  writeFileSync(preload, `
if (process.argv.includes('pinned-read-session')) require('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({
  managed: Boolean(process.env.OPENAI_API_KEY), alias: Boolean(process.env.CODEX_API_KEY),
  master: Boolean(process.env.O8_MASTER_KEY), unrelated: process.env.BRAVE_API_KEY === 'reader-service-fixture'
}));
`);
  try {
    process.env.O8_MASTER_KEY = Buffer.alloc(32, 63).toString('base64url');
    process.env.OPENAI_API_KEY = process.env.CODEX_API_KEY = 'reader-provider-fixture';
    process.env.BRAVE_API_KEY = 'reader-service-fixture';
    mutateProviderKey('OPENAI_API_KEY', { key: process.env.OPENAI_API_KEY, enabled: true });
    process.env.NODE_OPTIONS = `${previousNodeOptions ?? ''} --require=${preload}`.trim();
    const identity = await captureWorktreeMaterializationIdentity(workspace);
    await withPinnedWorkspaceReadSession(async () => {
      expect(await readPinnedWorkspaceFile(workspace, identity, 'file')).toBe('pinned contents');
    });
    expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual({ managed: false, alias: false, master: false, unrelated: true });
  } finally {
    mutateProviderKey('OPENAI_API_KEY', { key: null });
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
