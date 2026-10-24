import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({
  ensureDispatchBackendReady: vi.fn(async () => ({ ready: true })),
}));
vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed', probePath: '/', availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000, totalBytes: 100_000_000_000, error: null,
  })),
}));

const root = realpathSync(mkdtempSync(path.join(process.env.CORTEX_IDE_DATA_DIR!, 'launch-budget-')));
const repo = path.join(root, 'repo');
const bin = path.join(root, 'bin');
const capture = path.join(root, 'spawn.json');
const oldEnv = { ...process.env };
const npmCli = process.env.npm_execpath!;
Object.assign(process.env, {
  CORTEX_IDE_DATA_DIR: root,
  O8_DATA_DIR: root,
  O8_WORKTREE_ROOT: path.join(root, 'worktrees'),
  O8_OWNED_QODER_ROOT: path.join(root, 'owned-qoder'),
  O8_QODER_BIN: path.join(bin, 'qodercli'),
  O8_CRASH_SURVIVABLE_WORKERS: '0', O8_PACKAGED_APP: '0',
  O8_APFS_DEPENDENCY_IMAGES: '0', O8_APFS_COW_WORKSPACES: '1',
  O8_SKIP_PRELAUNCH_TYPECHECK: '1',
  PATH: `${bin}${path.delimiter}${process.env.PATH}`,
});

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
}

afterAll(async () => {
  const { closeDb } = await import('@/lib/db');
  closeDb();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
  Object.assign(process.env, oldEnv);
  rmSync(root, { recursive: true, force: true });
});

it('dispatches to fixture output within ten seconds with batched private installer preparation', async () => {
  mkdirSync(repo);
  mkdirSync(bin);
  git('init', '-q', '-b', 'main');
  const npmVersion = execFileSync(process.execPath, [npmCli, '--version'], { encoding: 'utf8' }).trim();
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\nvendor/\n');
  writeFileSync(path.join(repo, 'README.md'), 'committed\n');
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    name: 'launch-budget-fixture', version: '1.0.0', packageManager: `npm@${npmVersion}`,
    o8DependencyClone: { lifecycleInputs: [] },
    scripts: {
      test: 'node -e "process.exit(0)"',
      prebuild: 'node -e "require(\'fs\').writeFileSync(\'generated.pre\',\'ready\')"',
      build: 'node -e "if(!require(\'fs\').existsSync(\'generated.pre\')||process.env.npm_config_offline!==\'true\')process.exit(41);require(\'fs\').writeFileSync(\'generated.ready\',\'ready\')"',
      postinstall: 'npm run build',
    },
  }));
  const installedPackages = { 'node_modules/fixture': { version: '1.0.0' } };
  writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: installedPackages }));
  mkdirSync(path.join(repo, 'tools'));
  writeFileSync(path.join(repo, 'tools/package.json'), '{"name":"unrelated-tool"}');
  git('add', '.');
  git('-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'fixture');
  git('-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '--allow-empty', '-qm', 'packet base');
  git('remote', 'add', 'origin', repo);
  // The running checkout advances while the packet remains pinned to main.
  git('checkout', '-qb', 'donor');
  writeFileSync(path.join(repo, 'README.md'), 'donor documentation update\n');
  git('add', 'README.md');
  git('-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'docs only');
  // Required ignored assets are provided with a private directory clone.
  mkdirSync(path.join(repo, 'vendor'));
  for (let index = 0; index < 2_000; index += 1) {
    writeFileSync(path.join(repo, 'vendor', `${index}.js`), `module.exports = ${index};\n`);
  }
  mkdirSync(path.join(repo, 'node_modules', 'fixture'), { recursive: true });
  writeFileSync(path.join(repo, 'node_modules', 'fixture', 'index.js'), 'module.exports = 42;\n');
  writeFileSync(path.join(repo, 'node_modules', 'fixture', 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  writeFileSync(path.join(repo, 'node_modules', '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: installedPackages }));
  writeFileSync(path.join(repo, 'README.md'), 'source WIP\n');
  // The external package-manager fixture never installs packages or uses the network.
  writeFileSync(path.join(bin, 'npm'), [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const cp = require('node:child_process');",
    ...(process.env.O8_SPEED_DEPENDENCY_PAYLOAD ? [
      `const payload = ${JSON.stringify(path.resolve(process.env.O8_SPEED_DEPENDENCY_PAYLOAD))};`,
    ] : ['const payload = null;']),
    `const npmCli = ${JSON.stringify(npmCli)};`,
    "const args = process.argv.slice(2);",
    "if (args[0] !== 'ci') { const result = cp.spawnSync(process.execPath, [npmCli, ...args], { stdio: 'inherit' }); process.exit(result.status ?? 1); }",
    "fs.writeFileSync('installer-fallback.txt', 'ci\\n');",
    "if (payload) fs.cpSync(payload, 'node_modules', { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });",
    "fs.mkdirSync('node_modules/fixture', { recursive: true });",
    "for (let i = 0; i < 64; i++) fs.writeFileSync('node_modules/fixture/data-' + i, 'fixture');",
    "const path = require('node:path');",
    "const contained = path.relative(process.cwd(), process.env.HOME).startsWith('.o8-install-runtime/');",
    "const isolatedConfig = process.env.npm_config_userconfig === path.join(path.dirname(process.env.HOME), 'config/user.rc') && process.env.npm_config_globalconfig === path.join(path.dirname(process.env.HOME), 'config/global.rc');",
    "fs.writeFileSync('installer-runtime.json', JSON.stringify({ contained, isolatedConfig }));",
    "fs.writeFileSync('node_modules/fixture/index.js', 'module.exports = 42;\\n');",
    "const result = cp.spawnSync(process.execPath, [npmCli, 'rebuild', '.', '--offline'], { stdio: 'inherit' }); process.exit(result.status ?? 1);",
  ].join('\n'));
  chmodSync(path.join(bin, 'npm'), 0o755);
  writeFileSync(path.join(bin, 'qodercli'), [
    '#!/usr/bin/env node',
    "if (process.argv.includes('--version')) { console.log('qodercli 1.0.0'); process.exit(0); }",
    `console.log(JSON.stringify({ type: 'assistant', message: { content: 'SPEED_READY' } }));`,
    `require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ cwd: process.cwd(), prepared: require('node:fs').existsSync('generated.ready'), outputAt: Date.now() }));`,
  ].join('\n'));
  chmodSync(path.join(bin, 'qodercli'), 0o755);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  const [{ addRepo, updateRepo }, { runDispatchTick }, lanes, control] = await Promise.all([
    import('@/lib/repos/registry'), import('@/lib/orchestrator/scheduling'),
    import('@/lib/lane/registry'), import('@/lib/orchestrator/control-plane'),
  ]);
  const registration = await addRepo(repo);
  await updateRepo(registration.id, { setup: { ...registration.setup, workspaceIsolationPreference: 'auto', installCommand: 'npm ci --offline' } });
  const packet = {
    id: 'pkt-launch-budget', referenceLabel: 'LAUNCH-BUDGET', title: 'Launch fixture',
    summary: 'Measure dispatch to the persisted launch event.', workspaceTargetPath: repo,
    branchTarget: 'packet/launch-budget', runtime: 'qoder', dependencyLabels: [], dependencyPacketIds: [],
    queueState: 'queued', releaseState: 'pending', status: 'queued', blockedReason: null,
    lane: null, review: null, workerRouting: { requestedRuntime: 'qoder' } as OrchestratorPacket['workerRouting'],
  } as OrchestratorPacket;
  const state = { missionId: 'launch-budget', repoPath: repo, packets: [packet], updatedAt: new Date().toISOString() } as OrchestratorMissionState;
  control.writeOrchestratorControlPlaneState(state);
  const readMainHooks = () => { try { return git('config', '--local', '--get', 'core.hooksPath'); } catch { return null; } };
  const mainHooks = readMainHooks();
  const leaves = await import('@/lib/worktree/materialization-leaf-io');
  const ensureDirectory = vi.spyOn(leaves, 'ensurePinnedWorkspaceDirectory');
  const ensureFile = vi.spyOn(leaves, 'ensurePinnedWorkspaceFile');
  const createRuntime = 'createPinnedInstallRuntime' in leaves ? vi.spyOn(leaves, 'createPinnedInstallRuntime') : null;
  const fsPromises = await import('node:fs/promises');
  const lstat = fsPromises.lstat;
  let activeStats = 0;
  let maxAuditStats = 0;
  vi.spyOn(fsPromises, 'lstat').mockImplementation((...args: Parameters<typeof lstat>) => {
    if (!String(args[0]).includes(`${path.sep}node_modules${path.sep}fixture${path.sep}`)) return lstat(...args);
    activeStats += 1;
    maxAuditStats = Math.max(maxAuditStats, activeStats);
    return lstat(...args).finally(() => { activeStats -= 1; });
  });
  const launchBudgetMs = process.platform === 'linux' ? 10_000 : 60_000;
  const dispatchStartedAt = Date.now();
  const started = performance.now();
  const result = await runDispatchTick(state, { launchBudget: { maxLaunches: 1 } });
  const elapsedMs = Math.round(performance.now() - started);
  const lane = lanes.findLatestLaneByPacket(packet.id);
  const events = lane ? lanes.getLaneEvents(lane.id, 200) : [];
  const launched = events.find((event) => event.payload.eventLabel === 'session_launched');
  const timings = events.filter((event) => event.verb === 'worktree_preparation_timing').map((event) => event.payload);
  const sessionMs = launched ? new Date(launched.timestamp).getTime() - dispatchStartedAt : null;
  process.stdout.write('[packet-launch-budget] ' + JSON.stringify({ elapsedMs, sessionMs, timings, launched: Boolean(launched) }) + '\n');
  expect(result.packets[0]?.status, result.packets[0]?.blockedReason ?? undefined).toBe('launching');
  expect(launched).toBeDefined();
  expect(events.some((event) => event.verb === 'dependency_materialized')).toBe(true);
  const workspace = lane!.worktreePath!;
  for (let attempt = 0; attempt < 100 && !existsSync(capture); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(realpathSync(JSON.parse(readFileSync(capture, 'utf8')).cwd)).toBe(realpathSync(workspace));
  expect(JSON.parse(readFileSync(capture, 'utf8')).prepared).toBe(true);
  expect(readFileSync(path.join(workspace, 'README.md'), 'utf8')).toBe('committed\n');
  const savedPath = readdirSync(path.join(root, 'owned-qoder')).map((name) => path.join(root, 'owned-qoder', name, 'session.json')).find(existsSync)!;
  const saved = JSON.parse(readFileSync(savedPath, 'utf8'));
  const run = saved.activeRun ?? saved.recentRuns[0];
  await vi.waitFor(() => expect(readFileSync(run.stdoutPath, 'utf8')).toContain('SPEED_READY'));
  const outputAt = JSON.parse(readFileSync(capture, 'utf8')).outputAt as number;
  const { persistedWorkerStages } = await import(/* @vite-ignore */ path.resolve('scripts/speed/workers.mjs'));
  const stages = persistedWorkerStages(root, packet.id, dispatchStartedAt, Date.parse(run.startedAt));
  const runtimeDirectoryCalls = ensureDirectory.mock.calls.filter((call) => call[2].startsWith('.o8-install-runtime')).length;
  const runtimePreparations = runtimeDirectoryCalls + ensureFile.mock.calls.filter((call) => call[2].startsWith('.o8-install-runtime')).length + (createRuntime?.mock.calls.length ?? 0);
  const receipt = { dispatchToOutputMs: outputAt - dispatchStartedAt, sessionMs, stages,
    spawnToOutputMs: outputAt - Date.parse(run.startedAt), runtimePreparations, maxAuditStats };
  process.stdout.write('[packet-launch-output] ' + JSON.stringify(receipt) + '\n');
  if (process.env.O8_SPEED_RECEIPT) writeFileSync(process.env.O8_SPEED_RECEIPT, JSON.stringify(receipt));
  expect.soft(receipt.dispatchToOutputMs).toBeLessThan(launchBudgetMs);
  if (process.platform !== 'darwin') {
    expect(JSON.parse(readFileSync(path.join(workspace, 'installer-runtime.json'), 'utf8'))).toEqual({ contained: true, isolatedConfig: true });
    expect(readdirSync(path.join(workspace, '.o8-install-runtime'))).toHaveLength(0);
    expect.soft(runtimePreparations).toBe(1);
    expect.soft(maxAuditStats).toBeGreaterThan(1);
    expect(maxAuditStats).toBeLessThanOrEqual(32);
  }
  if (process.platform === 'darwin') {
    const { WorktreeManager } = await import('@/lib/worktree/manager');
    const managed = await new WorktreeManager(repo).list();
    expect(managed.find((entry) => entry.path === workspace)?.hydrationPaths).toContain('vendor');
    expect(readFileSync(path.join(workspace, 'vendor/1999.js'), 'utf8')).toBe('module.exports = 1999;\n');
    writeFileSync(path.join(workspace, 'vendor/1999.js'), 'worker asset');
    expect(readFileSync(path.join(repo, 'vendor/1999.js'), 'utf8')).toBe('module.exports = 1999;\n');
  }
  const privateFile = path.join(workspace, 'node_modules', 'fixture', 'index.js');
  expect(lstatSync(privateFile).ino).not.toBe(lstatSync(path.join(repo, 'node_modules', 'fixture', 'index.js')).ino);
  writeFileSync(privateFile, 'worker mutation\n');
  expect(readFileSync(path.join(repo, 'node_modules', 'fixture', 'index.js'), 'utf8')).toBe('module.exports = 42;\n');
  expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('source WIP\n');
  expect(sessionMs).toBeLessThan(60_000);
  expect(elapsedMs).toBeLessThan(60_000);
  if (process.platform !== 'darwin') return;
  expect(existsSync(path.join(workspace, 'installer-fallback.txt'))).toBe(false);
  expect(events.filter((event) => event.verb === 'worktree_preparation_timing'
    && event.payload.stage === 'dependency_selection').map((event) => event.payload)).toContainEqual(
    expect.objectContaining({ path: 'directory-clone', reason: 'matching-inputs' }),
  );
  expect(lstatSync(path.join(workspace, '.git')).isDirectory()).toBe(true);
  expect(existsSync(path.join(workspace, '.git/objects/info/alternates'))).toBe(false);
  expect(timings.map((timing) => timing.stage)).toEqual(process.platform === 'darwin' ? ['clone', 'checkout', 'asset_hydration', 'dependency_selection', 'dependency_materialization'] : ['dependency_materialization']);
  const workerGit = (...args: string[]) => execFileSync('git', args, {cwd:workspace, encoding:'utf8', stdio:'pipe'}).trim();
  const mainHead = git('rev-parse', 'refs/heads/main');
  workerGit('update-ref', '-d', 'refs/heads/main');
  workerGit('config', '--local', 'core.hooksPath', 'packet-hooks');
  workerGit('tag', 'packet-only');
  workerGit('update-ref', 'refs/stash', 'HEAD');
  expect(git('rev-parse', 'refs/heads/main')).toBe(mainHead);
  expect(readMainHooks()).toBe(mainHooks);
  expect(git('tag', '--list', 'packet-only')).toBe('');
  expect(git('for-each-ref', '--format=%(refname)', 'refs/stash')).toBe('');
  const unpublished = execFileSync('git', ['hash-object', '-w', '--stdin'], {cwd:workspace, input:'unpublished packet object', encoding:'utf8'}).trim();
  git('reflog', 'expire', '--expire=now', '--all');
  git('gc', '--prune=now');
  git('worktree', 'prune', '--expire=now');
  expect(workerGit('cat-file', '-p', unpublished)).toBe('unpublished packet object');
}, 120_000);
