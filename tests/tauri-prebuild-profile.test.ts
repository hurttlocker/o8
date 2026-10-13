import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { createRetainedGeneratedOutputFixture } from './generated-output-fixture';

const source = process.cwd();
const require = createRequire(import.meta.url);

it('retains ordinary prebuild creation authority across default prebuild and release lifetimes', async () => {
  const root = await createRetainedGeneratedOutputFixture('o8-prebuild-lifetime-');
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const scripts = path.join(repo, 'scripts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(home);
  mkdirSync(path.join(repo, '.fixture'));
  writeFileSync(path.join(repo, '.gitignore'), '.next\nout\nnode_modules\n.fixture\n.o8-generated-output-store\n');
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'prebuild-fixture', version: '0.0.0',
    scripts: { build: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(source, 'scripts/build.mjs'))}` } }));
  // Real callers, guard, recipe, manifest, cache and native producer; only expensive
  // compiler/export/smoke payloads are stand-ins. No containing manager is seeded.
  for (const name of ['preship-cleanup.mjs', 'bust-stale-patch-cache.mjs']) {
    writeFileSync(path.join(scripts, name), readFileSync(path.join(source, 'scripts', name)));
  }
  for (const name of ['build-speech-local.mjs', 'build-pi-write.mjs']) {
    writeFileSync(path.join(scripts, name), 'process.exit(0);');
  }
  writeFileSync(path.join(scripts, 'tauri-export.mjs'), `
    const fs = await import('node:fs');
    fs.mkdirSync('out', { recursive: true }); fs.writeFileSync('out/server.js', 'fixture artifact');
  `);
  writeFileSync(path.join(scripts, 'packaged-server-smoke.mjs'), `
    const fs = await import('node:fs');
    if (fs.readFileSync('.next/BUILD_ID', 'utf8') !== 'native fixture') process.exit(78);
    if (process.env.O8_FIXTURE_SMOKE_WAIT) {
      fs.writeFileSync('.fixture/smoke-ready', 'ready');
      const deadline = Date.now() + 120000;
      while (!fs.existsSync('.fixture/smoke-release')) {
        if (Date.now() > deadline) process.exit(79);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    fs.writeFileSync('.fixture/profile.json', JSON.stringify({ modern: process.env.O8_DATA_DIR,
      legacy: process.env.CORTEX_IDE_DATA_DIR }));
  `);
  const next = path.join(repo, 'node_modules/next/dist/bin');
  mkdirSync(next, { recursive: true });
  symlinkSync(path.dirname(require.resolve('better-sqlite3/package.json')), path.join(repo, 'node_modules/better-sqlite3'), 'dir');
  writeFileSync(path.join(next, 'next'), `
    const fs = require('node:fs');
    fs.mkdirSync('.next/cache', { recursive: true });
    fs.writeFileSync('.next/cache/proof.bin', 'fixture cache');
    fs.writeFileSync('.next/BUILD_ID', 'native fixture');
    fs.appendFileSync('.fixture/compiler-calls', 'build\\n');
  `);
  for (const args of [['init', '--initial-branch=main'], ['add', '.'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  }
  const env = { ...process.env, HOME: home, O8_RELEASE_BUILD_CACHE_DIR: path.join(root, 'cache'),
    O8_RELEASE_BUILD_CACHE_MAX_BYTES: '10485760', O8_RELEASE_LOCK_PATH: path.join(root, 'release.lock'),
    O8_RELEASE_BROADCAST_CLI: 'true', TSX_TSCONFIG_PATH: path.join(source, 'tsconfig.json') };
  for (const key of ['O8_DATA_DIR', 'CORTEX_IDE_DATA_DIR', 'CORTEX_IDE_DB_PATH', 'O8_OPERATOR_DATA_DIR',
    'O8_RELEASE_BUILD_DATA_DIR', 'O8_RELEASE_CACHE_RUN_ID', 'O8_RELEASE_CACHE_PREBUILD_MARKER']) {
    delete (env as NodeJS.ProcessEnv)[key];
  }
  let invocation = 0;
  function run(args: string[], extra: Partial<NodeJS.ProcessEnv> = {}) {
    const result = spawnSync(process.execPath, args, { cwd: repo, env: { ...env, ...extra },
      encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 ** 2 });
    writeFileSync(path.join(root, `command-${++invocation}.json`), JSON.stringify({ args,
      pid: result.pid, exit: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }, null, 2));
    return result;
  }
  const prebuild = [process.env.O8_PREBUILD_TEST_SCRIPT || path.join(source, 'scripts/tauri-prebuild.mjs')];
  const first = run(prebuild);
  expect(first.status, first.stderr + first.stdout).toBe(0);
  const profile = JSON.parse(readFileSync(path.join(repo, '.fixture/profile.json'), 'utf8')).modern as string;
  expect(existsSync(profile), 'lifecycle profile must survive the first caller').toBe(true);
  const databasePath = path.join(profile, 'cortex-ide.db');
  function resource() {
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try { return JSON.parse((db.prepare('SELECT payload_json FROM workspace_generated_outputs WHERE workspace_path = ?')
      .get(realpathSync(repo)) as { payload_json: string }).payload_json); }
    finally { db.close(); }
  }
  let original = resource();
  expect(original).toMatchObject({ state: 'succeeded', origin: 'managed-creation',
    creationAuthority: { kind: 'prebuild' } });
  expect(original.owner).toBeUndefined();
  expect(original.attempt.children.length).toBeGreaterThan(0);
  expect(original.attempt.children.every((child: { identity: unknown; observedClosed: boolean; exitCode: number }) =>
    child.identity && child.observedClosed && child.exitCode === 0)).toBe(true);
  const marker = readFileSync(path.join(repo, '.o8-generated-output-store'), 'utf8');
  expect(marker).toBe(createHash('sha256').update(realpathSync(databasePath)).digest('hex'));
  const outputIdentity = lstatSync(path.join(repo, '.next'));
  const profileCount = readdirSync(path.dirname(profile)).length;
  const second = run(prebuild);
  expect(second.status, second.stderr + second.stdout).toBe(0);
  expect(second.stdout).toContain('reused verified artifact');
  expect(resource()).toEqual(original); // Reuse must not invent a successful child or replace its receipt.
  const noop = { command: process.execPath, args: ['-e', 'process.exit(0)'] };
  const planPath = path.join(root, 'release-plan.json');
  writeFileSync(planPath, JSON.stringify({ preflight: noop, build: { command: process.execPath, args: prebuild },
    notarize: noop, publish: noop }));
  const release = ['--input-type=module', '-e', `
    const { runShipWorkflow } = await import(${JSON.stringify(pathToFileURL(path.join(source, 'scripts/lib/ship-broadcast.mjs')).href)});
    await runShipWorkflow({ root: process.cwd(), version: '0.0.0' });
  `];
  const released = run(release, { O8_RELEASE_TEST_MODE: '1', O8_RELEASE_TEST_PLAN: planPath });
  expect(released.status, released.stderr + released.stdout).toBe(0);
  expect(released.stdout).toContain('reused verified artifact');
  expect(resource()).toEqual(original);
  expect(readdirSync(path.dirname(profile))).toHaveLength(profileCount);
  expect(lstatSync(path.join(repo, '.next')).ino).toBe(outputIdentity.ino);
  expect(readFileSync(path.join(repo, '.fixture/compiler-calls'), 'utf8')).toBe('build\n');
  const failingPlan = JSON.parse(readFileSync(planPath, 'utf8'));
  failingPlan.publish = { command: process.execPath, args: ['-e', 'process.exit(42)'] };
  writeFileSync(planPath, JSON.stringify(failingPlan));
  const failedRelease = run(release, { O8_RELEASE_TEST_MODE: '1', O8_RELEASE_TEST_PLAN: planPath });
  expect(failedRelease.status).not.toBe(0);
  expect(resource()).toEqual(original);
  // A live reuse owner retains the same exclusion even though no compiler runs.
  const live = spawn(process.execPath, prebuild, { cwd: repo,
    env: { ...env, O8_FIXTURE_SMOKE_WAIT: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(live, 'close');
  let liveOutput = '';
  live.stdout.on('data', chunk => { liveOutput += chunk; });
  live.stderr.on('data', chunk => { liveOutput += chunk; });
  let competingExit: number | null = null;
  try {
    await vi.waitFor(() => expect(existsSync(path.join(repo, '.fixture/smoke-ready'))).toBe(true), { timeout: 60_000 });
    const competing = run(prebuild);
    competingExit = competing.status;
    expect(competing.status).not.toBe(0);
    expect(competing.stderr).toMatch(/owned|lease|lifecycle/i);
    expect(live.exitCode).toBeNull();
  } finally {
    writeFileSync(path.join(repo, '.fixture/smoke-release'), 'release owned fixture smoke');
    expect((await closed)[0], liveOutput).toBe(0);
  }
  expect(resource()).toEqual(original);
  // The next ordinary build finds the retained profile without an environment override.
  const normalBuild = [path.join(source, 'scripts/build.mjs')];
  const builtNormally = run(normalBuild);
  expect(builtNormally.status, builtNormally.stderr + builtNormally.stdout).toBe(0);
  const nextReceipt = resource();
  expect(nextReceipt.resourceId).toBe(original.resourceId);
  expect(nextReceipt.creationAuthority).toEqual(original.creationAuthority);
  expect(nextReceipt.attempt.id).not.toBe(original.attempt.id);
  expect(nextReceipt.state).toBe('succeeded');
  original = nextReceipt;
  const conflict = path.join(root, 'conflicting-profile');
  mkdirSync(conflict);
  const conflictingDb = path.join(conflict, 'cortex-ide.db');
  const emptyDatabase = new Database(conflictingDb);
  emptyDatabase.exec('CREATE TABLE unrelated(value TEXT)');
  emptyDatabase.close();
  const conflictingBytes = readFileSync(conflictingDb);
  const mismatched = run(normalBuild, { O8_DATA_DIR: conflict, CORTEX_IDE_DATA_DIR: conflict });
  expect(mismatched.status).not.toBe(0);
  expect(mismatched.stderr).toContain('mismatched');
  expect(readFileSync(conflictingDb)).toEqual(conflictingBytes);
  expect(resource()).toEqual(original);
  // Persist a real retention hold through the production API. It is intentionally retained.
  const held = run(['--import', path.join(source, 'scripts/register-server-only-stub.mjs'),
    '--import', require.resolve('tsx'), '--input-type=module', '-e', `
      const ns = await import(${JSON.stringify(pathToFileURL(path.join(source, 'src/lib/workspace/retention-holds.ts')).href)});
      const { acquireWorkspaceRetentionHold } = ns.default ?? ns;
      acquireWorkspaceRetentionHold({ repositoryPath: process.cwd(), repositoryUuid: 'fixture',
        worktreeId: 'ordinary-output', packetId: 'fixture', laneId: 'fixture', holdId: 'fixture-hold',
        reason: 'Retain prebuild regression evidence', identity: ${JSON.stringify(original.output)} });
    `], { O8_DATA_DIR: profile, CORTEX_IDE_DATA_DIR: profile });
  expect(held.status, held.stderr).toBe(0);
  const heldAttempt = run(prebuild);
  expect(heldAttempt.status).not.toBe(0);
  expect(heldAttempt.stderr).toContain('retention hold');
  expect(resource()).toEqual(original);
  writeFileSync(path.join(root, 'product-state.json'), JSON.stringify({ profile, databasePath,
    marker, resource: resource(), profileCount, output: { device: outputIdentity.dev, inode: outputIdentity.ino },
    nativeExclusion: { competingExit, ownerExit: live.exitCode }, hold: 'retained' }, null, 2));
  // Existing lock and unknown output remain refusals, never disposal authority.
  writeFileSync(path.join(repo, '.next/lock'), 'retained lock');
  const refused = run(prebuild);
  expect(refused.status).not.toBe(0);
  expect(readFileSync(path.join(repo, '.next/lock'), 'utf8')).toBe('retained lock');
  expect(resource()).toEqual(original);
  renameSync(path.join(repo, '.o8-generated-output-store'), path.join(repo, '.fixture/lost-store-binding'));
  const missing = run(normalBuild);
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain('binding is missing');
  expect(existsSync(path.join(repo, '.o8-generated-output-store'))).toBe(false);
  const missingAndConflicting = run(normalBuild, { O8_DATA_DIR: conflict, CORTEX_IDE_DATA_DIR: conflict,
    CORTEX_IDE_DB_PATH: conflictingDb });
  expect(missingAndConflicting.status).not.toBe(0);
  expect(missingAndConflicting.stderr).toContain('binding is missing');
  expect(readFileSync(conflictingDb)).toEqual(conflictingBytes);
  expect(resource()).toEqual(original);
}, 420_000);
