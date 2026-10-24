import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { closeDb } from '@/lib/db';
import { WorktreeManager } from '@/lib/worktree/manager';
import { withWorktreeMetaTransaction } from '@/lib/worktree/metadata-store';
import { isManagedPacketWorktreeId, resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({ accountingStatus: 'observed', probePath: '/',
    availableBytes: 90_000_000_000, freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000, error: null })),
}));

const run = promisify(execFile);
let root: string;
let repo: string;
let originalHead: string;
const packetId = 'pkt-index-fixture';

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(process.env.CORTEX_IDE_DATA_DIR!, 'index-exclusion-')));
  repo = path.join(root, 'source');
  await mkdir(repo);
  const git = (...args: string[]) => run('git', args, { cwd: repo, timeout: 10_000 });
  await git('init', '-b', 'main');
  await writeFile(path.join(repo, 'seed.txt'), 'source remains unchanged\n');
  await git('add', 'seed.txt');
  await git('-c', 'user.name=o8-test', '-c', 'user.email=test@o8.invalid', 'commit', '-m', 'fixture');
  originalHead = (await git('rev-parse', 'HEAD')).stdout.trim();
  vi.stubEnv('O8_WORKTREE_ROOT', path.join(root, 'worktrees'));
  vi.stubEnv('O8_SKIP_PRELAUNCH_TYPECHECK', '1');
});

afterAll(async () => {
  closeDb();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

async function create(branch: string, id = packetId) {
  return new WorktreeManager(repo).create({ agentType: 'codex', managed: true, packetId: id,
    taskName: 'index exclusion', branchName: branch, baseBranch: 'main', skipSetup: true,
    isolationPreference: 'git-worktree' });
}

it('creates a packet with the exclusion suffix while preserving the source and metadata namespace', async () => {
  const layout = resolveWorktreeRootLayout(repo);
  const created = await create('fixture/index-first');
  expect(path.basename(created.path)).toMatch(/-index\.noindex$/);
  expect(path.dirname(created.path)).toBe(layout.primaryBase);
  expect(created.id).toBe(path.basename(created.path));
  expect(isManagedPacketWorktreeId(created.id, packetId)).toBe(true);
  expect(await readFile(path.join(created.path, 'seed.txt'), 'utf8')).toBe('source remains unchanged\n');
  expect((await run('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()).toBe(originalHead);
  expect((await run('git', ['status', '--porcelain'], { cwd: repo })).stdout).toBe('');
  const reopened = await new WorktreeManager(repo).list();
  expect(reopened.find(entry => entry.id === created.id)?.path).toBe(created.path);
}, 60_000);

it('keeps the exclusion suffix through a real collision and still discovers a legacy packet', async () => {
  const layout = resolveWorktreeRootLayout(repo);
  const collisionPacketId = 'pkt-index-collision';
  const legacyId = `packet-${collisionPacketId}-abcd`;
  const legacyPath = path.join(layout.primaryBase, legacyId);
  await run('git', ['worktree', 'add', legacyPath, '-b', 'fixture/index-legacy'], { cwd: repo });
  await withWorktreeMetaTransaction(repo, transaction => transaction.save(legacyId, {
    id: legacyId, packetId: collisionPacketId, agentType: 'codex', baseBranch: 'main',
    createdAt: Date.now(), claudeManaged: false, taskName: 'legacy packet', status: 'ready',
    branchName: 'fixture/index-legacy', isolationKind: 'git-worktree',
  }));
  const occupiedPath = path.join(layout.primaryBase, `packet-${collisionPacketId}-index.noindex`);
  await run('git', ['worktree', 'add', occupiedPath, '-b', 'fixture/index-occupied'], { cwd: repo });
  const created = await create('fixture/index-collision', collisionPacketId);
  expect(created.id).toMatch(/^packet-pkt-index-collision-[a-z0-9]{4}-index\.noindex$/);
  expect(isManagedPacketWorktreeId(created.id, collisionPacketId)).toBe(true);
  expect(isManagedPacketWorktreeId(legacyId, collisionPacketId)).toBe(true);
  const reopened = await new WorktreeManager(repo).list();
  expect(reopened.find(entry => entry.id === created.id)?.path).toBe(created.path);
  expect(reopened.find(entry => entry.id === legacyId)?.path).toBe(legacyPath);
}, 60_000);
