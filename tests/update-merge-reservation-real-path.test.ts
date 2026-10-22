import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

vi.mock('@/lib/lane/merge-decomposition', () => ({ enqueueMergeDecompositions: async () => '' }));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-update-merge-')));
vi.stubEnv('O8_DATA_DIR', join(root, 'data'));
vi.stubEnv('CORTEX_IDE_DATA_DIR', join(root, 'data'));
vi.stubEnv('O8_SKIP_PRELAUNCH_TYPECHECK', '1');
const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const { performWorktreeSideMerge } = await import('@/lib/lane/worktree-side-merge');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { bindOwnedPacketSession } = await import('./helpers/managed-packet-worktree');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
await import('@/lib/orchestrator/control-plane');
afterAll(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

it('excludes a merge during native drain and holds admitted publication through settlement', async () => {
  await updateOperatorDefaults({ productTelemetryEnabled: false, storageReserveRatio: 0.0001, storageReserveFloorGb: 0.001 });
  const repo = join(root, 'repo');
  const origin = join(root, 'origin.git');
  git(root, 'init', '--bare', origin);
  git(root, 'clone', origin, repo);
  git(repo, 'checkout', '-b', 'main');
  git(repo, 'config', 'user.name', 'o8-test'); git(repo, 'config', 'user.email', 'o8@example.test');
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  git(repo, 'add', 'file.txt'); git(repo, 'commit', '-m', 'base'); git(repo, 'push', '-u', 'origin', 'main');
  const branch = 'inline/update-merge';
  const packetId = 'pkt-update-merge';
  const manager = getWorktreeManager(repo);
  const worktree = await manager.create({ agentType: 'codex', taskName: packetId, branchName: branch,
    baseBranch: 'main', packetId, skipSetup: true, isolationPreference: 'git-worktree' });
  const sessionKey = await bindOwnedPacketSession(repo, worktree, { packetId, branch });
  writeFileSync(join(worktree.path, 'file.txt'), 'base\nworker\n');
  git(worktree.path, 'add', 'file.txt'); git(worktree.path, 'commit', '-m', 'worker change');
  const lane = createLane({ repoPath: repo, worktreePath: worktree.path, branch, baseBranch: 'main',
    runtime: 'codex', packetId, sessionKey });
  setLaneStatus(lane.id, 'reviewing', 'system');
  const merge = () => performWorktreeSideMerge({ lane, command: { verb: 'merge', laneId: lane.id, actor: 'system',
    orchestratorReviewed: true }, actor: 'system', gateResult: { passed: true, violations: [] },
    createLaneActionApproval: async (_lane, _actor, input) => ({ ok: false, laneId: lane.id, note: input.note }) });
  // Retirement has its own real-path suite. Keep this test at publication and
  // lane settlement rather than invoking the unrelated workspace retire queue.
  const cleanup = vi.spyOn(manager, 'cleanup').mockResolvedValue(false);
  const directory = join(root, 'data/cli-operation-admission');
  const id = randomUUID(); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${id}.json`), JSON.stringify({ version: 1, id, kind: 'restart', pid: process.pid,
    startedAt: new Date().toISOString(), stage: 'preparing' }));
  try {
    expect(await merge()).toMatchObject({ ok: false, reason: 'app_restart_pending' });
    expect(getLane(lane.id)?.status).toBe('reviewing');
    expect(git(origin, 'show', 'main:file.txt')).toBe('base');
  } finally { rmSync(directory, { recursive: true }); }
  const started = join(root, 'publishing'); const released = join(root, 'release-publication');
  const hook = join(repo, '.git/hooks/pre-push');
  writeFileSync(hook, `#!/bin/sh\nwhile read local_ref local_sha remote_ref remote_sha; do\nif [ "$remote_ref" = refs/heads/main ]; then\ntouch '${started}'\nwhile [ ! -f '${released}' ]; do sleep 0.02; done\nfi\ndone\n`);
  chmodSync(hook, 0o700);
  const pending = merge();
  try {
    await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 10_000 });
    const files = readdirSync(join(root, 'data/work-launches'));
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(root, 'data/work-launches', files[0]), 'utf8'))).toMatchObject({ pid: null });
    expect(getLane(lane.id)?.status).toBe('merging');
  } finally { writeFileSync(released, 'settle'); }
  expect(await pending).toMatchObject({ ok: true, pushedToOrigin: true });
  expect(readdirSync(join(root, 'data/work-launches'))).toEqual([]);
  expect(getLane(lane.id)?.status).toBe('completed');
  cleanup.mockRestore();
});
