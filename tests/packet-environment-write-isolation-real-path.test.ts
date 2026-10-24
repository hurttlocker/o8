import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: async () => undefined }));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({
  ensureDispatchBackendReady: async () => ({ ready: true }),
}));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: async () => undefined }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: async () => undefined }));
vi.mock('@/lib/worktree/storage-telemetry', async (original) => ({
  ...await original<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: async () => ({ accountingStatus: 'observed', probePath: '/',
    availableBytes: 90_000_000_000, freeBytes: 90_000_000_000, totalBytes: 100_000_000_000, error: null }),
}));

const root = mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'env-write-isolation-'));
const capture = join(root, 'worker.json');
const binary = join(root, 'qodercli');
vi.stubEnv('O8_DATA_DIR', root);
vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
vi.stubEnv('O8_WORKTREE_ROOT', join(root, 'worktrees'));
vi.stubEnv('O8_OWNED_QODER_ROOT', join(root, 'sessions'));
vi.stubEnv('O8_QODER_BIN', binary);
vi.stubEnv('O8_SKIP_PRELAUNCH_TYPECHECK', '1');
vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', '1');
vi.stubEnv('O8_WORKER_SANDBOX', '0');
vi.stubEnv('O8_PACKAGED_APP', '0');
writeFileSync(binary, String.raw`#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('qodercli 1.0.0'); process.exit(0); }
for (const name of ['.env', '.env.local']) {
  if (fs.existsSync(name)) fs.appendFileSync(name, 'O8_FIXTURE_WRITE=worker\n');
}
const inherited = ['.env', '.env.local'].some(name => fs.existsSync(name));
// A task with packet-local, non-secret configuration still runs after opting out.
fs.writeFileSync('task.env', 'O8_TASK_FIXTURE=scoped\n');
const value = require('node:child_process').execFileSync(process.execPath,
  ['--env-file=task.env', '-e', 'process.stdout.write(process.env.O8_TASK_FIXTURE)'], { encoding: 'utf8' });
fs.unlinkSync('task.env');
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ cwd: process.cwd(), inherited, value }));
process.stderr.write('fixture completed\n');
process.exit(23);
`);
chmodSync(binary, 0o755);
const { closeDb } = await import('@/lib/db');
const repos = await import('@/lib/repos/registry');
const lanes = await import('@/lib/lane/registry');
const control = await import('@/lib/orchestrator/control-plane');
const { runDispatchTick } = await import('@/lib/orchestrator/scheduling');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { readWorktreeMetaSnapshot } = await import('@/lib/worktree/metadata-store');
const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
const { WorktreeManager } = await import('@/lib/worktree/manager');

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}
async function fixture(id: string, mode?: 'copy' | 'symlink' | 'skip') {
  rmSync(capture, { force: true });
  const repoPath = join(root, id);
  mkdirSync(repoPath);
  git(repoPath, 'init', '-qb', 'main');
  writeFileSync(join(repoPath, '.gitignore'), '.env*\n');
  writeFileSync(join(repoPath, 'README.md'), 'fixture\n');
  git(repoPath, 'add', '.');
  git(repoPath, '-c', 'user.name=o8-test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');
  const origin = join(root, id + '.git');
  execFileSync('git', ['clone', '--bare', repoPath, origin], { stdio: 'pipe' });
  git(repoPath, 'remote', 'add', 'origin', origin);
  git(repoPath, 'fetch', 'origin');
  writeFileSync(join(repoPath, '.env'), 'O8_ENV_FIXTURE=base\n');
  writeFileSync(join(repoPath, '.env.local'), 'O8_ENV_FIXTURE=local\n');
  const digest = () => ['.env', '.env.local'].map(name =>
    createHash('sha256').update(readFileSync(join(repoPath, name))).digest('hex'));
  const before = digest();
  const repo = await repos.addRepo(repoPath);
  await repos.updateRepo(repo.id, { setup: { ...repo.setup,
    ...(mode ? { envMode: mode } : {}), workspaceIsolationPreference: 'git-worktree' } });
  const packet: OrchestratorPacket = {
    id, referenceLabel: id, title: id, summary: 'verify environment write isolation',
    workspaceTargetPath: repoPath, branchTarget: 'packet/' + id, runtime: 'qoder',
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued', releaseState: 'pending',
    status: 'queued', blockedReason: null, lane: null,
    workerRouting: { requestedRuntime: 'qoder' } as OrchestratorPacket['workerRouting'],
  };
  const state = { ...createEmptyOrchestratorMissionState(), missionId: id, repoPath, packets: [packet] };
  control.writeOrchestratorControlPlaneState(state);
  const result = await runDispatchTick(state, { launchBudget: { maxLaunches: 1 } });
  const lane = lanes.findLatestLaneByPacket(id)!;
  if (result.packets[0].status === 'launching') {
    await vi.waitFor(() => expect(lanes.getLaneEvents(lane.id, 200)
      .some(event => event.verb === 'runtime_process_exit')).toBe(true), { timeout: 15_000 });
  }
  return { repoPath, result, lane, before, after: digest() };
}

afterAll(() => {
  closeDb();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it.each([undefined, 'copy', 'symlink'] as const)('refuses %s inherited environment before an unsandboxed worker can write through', async mode => {
  const f = await fixture('refused-' + (mode ?? 'default'), mode);
  expect(f.after).toEqual(f.before);
  expect(f.result.packets[0].status).toBe('blocked');
  expect(f.result.packets[0].blockedReason).toContain('Packet environment inheritance is unsafe');
  expect(f.result.packets[0].blockedReason).toContain('envMode: skip');
  expect(lanes.getLaneEvents(f.lane.id).find(event => event.verb === 'worktree_provision_failed')?.payload.cause)
    .toContain('Packet environment inheritance is unsafe');
  expect(lanes.getLane(f.lane.id)?.sessionKey).toBeNull();
  expect(lanes.getLaneEvents(f.lane.id).some(event => event.verb === 'worktree_provision_failed')).toBe(true);
  expect(existsSync(capture)).toBe(false);
  expect(existsSync(join(resolveWorktreeRootLayout(f.repoPath).primaryBase, 'packet-' + f.lane.packetId))).toBe(false);
  expect(Object.values(await readWorktreeMetaSnapshot(f.repoPath))
    .some(entry => entry.packetId === f.lane.packetId)).toBe(false);
}, 120_000);

it('dispatches with explicit skip, runs scoped configuration, and retires without inherited credential material', async () => {
  const f = await fixture('explicit-skip', 'skip');
  expect(f.result.packets[0].status, f.result.packets[0].blockedReason ?? '').toBe('launching');
  expect(f.after).toEqual(f.before);
  const receipt = JSON.parse(readFileSync(capture, 'utf8'));
  expect(receipt).toEqual({ cwd: f.lane.worktreePath, inherited: false, value: 'scoped' });
  const manager = new WorktreeManager(f.repoPath);
  const id = 'packet-' + f.lane.packetId;
  expect((await readWorktreeMetaSnapshot(f.repoPath))[id]?.environmentReferences).toBeUndefined();
  // The real governed cleanup path rejects credential material; this checkout retires cleanly.
  expect(await manager.cleanup(id, { force: true, deleteBranch: true })).toBe(true);
  expect(existsSync(f.lane.worktreePath!)).toBe(false);
}, 120_000);


it.each(['fallback', 'nested', 'existing-link', 'existing-file', 'empty-list', 'source-absent'] as const)(
  'checks %s through managed creation without changing source configuration', async kind => {
    const repoPath = join(root, 'bootstrap-' + kind);
    mkdirSync(repoPath);
    git(repoPath, 'init', '-qb', 'main');
    writeFileSync(join(repoPath, 'README.md'), 'fixture\n');
    const name = kind === 'nested' ? 'config/development.env' : '.env';
    if (kind === 'nested') mkdirSync(join(repoPath, 'config'));
    const source = join(repoPath, kind === 'fallback' ? '.env.local' : name);
    if (kind !== 'source-absent') writeFileSync(source, 'O8_ENV_FIXTURE=source\n');
    if (kind === 'existing-link') {
      rmSync(source);
      symlinkSync('README.md', source);
    }
    git(repoPath, 'add', 'README.md');
    if (kind === 'existing-file' || kind === 'existing-link') git(repoPath, 'add', name);
    git(repoPath, '-c', 'user.name=o8-test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');
    const before = existsSync(source) ? readFileSync(source, 'utf8') : null;
    const manager = new WorktreeManager(repoPath);
    const create = manager.create({ agentType: 'qoder', taskName: kind, packetId: kind,
      baseBranch: 'main', managed: true, skipSetup: true, isolationPreference: 'git-worktree',
      envFiles: kind === 'empty-list' ? [] : ['./' + name] });
    if (['fallback', 'nested', 'existing-link'].includes(kind)) {
      await expect(create).rejects.toThrow('Packet environment inheritance is unsafe');
    } else {
      const workspace = await create;
      expect((await readWorktreeMetaSnapshot(repoPath))[workspace.id]?.environmentReferences).toBeUndefined();
      expect(await manager.cleanup(workspace.id, { force: true, deleteBranch: true })).toBe(true);
    }
    expect(existsSync(source) ? readFileSync(source, 'utf8') : null).toBe(before);
  }, 120_000,
);
