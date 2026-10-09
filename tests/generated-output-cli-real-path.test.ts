import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createRetainedGeneratedOutputFixture } from './generated-output-fixture';

const exec = promisify(execFile);
const source = process.cwd();
const require = createRequire(import.meta.url);

async function fixture() {
  const root = await createRetainedGeneratedOutputFixture('o8-generated-cli-');
  const repo = path.join(root, 'repo'); const data = path.join(root, 'data');
  await mkdir(repo); await mkdir(data, { mode: 0o700 });
  await writeFile(path.join(repo, '.gitignore'), '.next\nnode_modules\n.o8-generated-output-store\n.o8-retired-generated-*\n');
  await writeFile(path.join(repo, 'package.json'), '{"name":"generated-output-fixture","private":true}\n');
  await mkdir(path.join(repo, 'scripts'));
  await writeFile(path.join(repo, 'scripts', 'bust-stale-patch-cache.mjs'),
    await readFile(path.join(source, 'scripts', 'bust-stale-patch-cache.mjs')));
  for (const args of [['init', '--initial-branch=main'], ['add', '.'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture']]) {
    await exec('git', args, { cwd: repo });
  }
  const probes = path.join(root, 'native-cwd-probes'); await mkdir(probes, { mode: 0o700 });
  const observer = pathToFileURL(path.join(source, 'tests/generated-output-native-cwd-observer.mjs')).href;
  const env = { ...process.env, O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
    CORTEX_IDE_DB_PATH: path.join(data, 'fixture.db'), TSX_TSCONFIG_PATH: path.join(source, 'tsconfig.json'),
    O8_TEST_NATIVE_CWD_PROBE_ROOT: probes,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${observer}`].filter(Boolean).join(' ') };
  let commandIndex = 0;
  const invoke = async (args: string[], timeout: number) => {
    const index = ++commandIndex; const startedAt = new Date().toISOString();
    const execution = exec(process.execPath, args, { cwd: source, env, timeout, maxBuffer: 1024 ** 2 });
    const closed = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
      execution.child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    const save = async (stdout: string, stderr: string) => writeFile(path.join(root, `command-${index}.json`),
      JSON.stringify({ args, timeout, startedAt, closedAt: new Date().toISOString(), pid: execution.child.pid,
        nativeClose: await closed, stdout, stderr }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    try { const result = await execution; await save(result.stdout, result.stderr); return result; }
    catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string };
      await save(result.stdout ?? '', result.stderr ?? '');
      throw new Error(result.stderr?.trim() || 'Native fixture command failed without stderr', { cause: error });
    }
  };
  const cold = async (script: string, timeout = 30_000) => {
    const result = await invoke(['--import', path.join(source, 'scripts/register-server-only-stub.mjs'),
      '--import', require.resolve('tsx'), '--input-type=module', '-e', script], timeout);
    const match = /^O8_GENERATED_RESULT (.+)$/m.exec(result.stdout);
    if (!match) throw new Error(result.stdout + result.stderr);
    return JSON.parse(match[1]);
  };
  const created = await cold(`
    const ns = await import(${JSON.stringify(pathToFileURL(path.join(source, 'src/lib/worktree/manager.ts')).href)});
    const { WorktreeManager } = ns.default ?? ns;
    const entry = await new WorktreeManager(${JSON.stringify(repo)}).create({
      agentType: 'codex', taskName: 'Generated output fixture', branchName: 'codex/generated-output-fixture',
      baseBranch: 'main', managed: true, skipSetup: true,
    });
    console.log('O8_GENERATED_RESULT ' + JSON.stringify(entry));
  `, 60_000) as { id: string; path: string };
  const workspace = await realpath(created.path);
  const cli = async (...args: string[]) => {
    const result = await invoke([path.join(source, 'scripts/generated-output.mjs'), ...args], 30_000);
    return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
  };
  return { root, repo, data, env, cold, created, workspace, cli };
}

it('persists ownership before a fast producer, verifies CLI bank/recovery, and cold-replays without the workspace', async () => {
  const input = await fixture();
  const next = path.join(input.workspace, 'node_modules/next/dist/bin');
  await mkdir(next, { recursive: true });
  // A tiny compiler stand-in exercises the production build wrapper and its
  // native exec boundary; this test does not claim a real Next compilation.
  await writeFile(path.join(next, 'next'), `
    const fs = require('node:fs'); const path = require('node:path');
    const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
    const db = new Database(process.env.CORTEX_IDE_DB_PATH, { readonly: true });
    const row = db.prepare('SELECT payload_json FROM workspace_generated_outputs WHERE workspace_path = ?').get(process.cwd());
    const resource = JSON.parse(row.payload_json); db.close();
    const child = resource.attempt.children.find(row => row.pid === process.pid);
    if (resource.state !== 'active' || !child?.identity || child.observedClosed
      || process.argv.slice(2).join(' ') !== 'build --webpack') process.exit(79);
    fs.mkdirSync('.next/cache', { recursive: true });
    fs.writeFileSync('.next/cache/proof.bin', 'native generated fixture bytes');
  `);
  await exec(process.execPath, [path.join(source, 'scripts/build.mjs')], {
    cwd: input.workspace, env: input.env, timeout: 30_000, maxBuffer: 1024 ** 2,
  });
  const registered = await input.cli('register', '--workspace', input.workspace);
  const id = registered.resource.resourceId;
  expect(registered.resource.state).toBe('succeeded');
  expect(registered.resource.owner).toEqual({ repositoryPath: input.repo, worktreeId: input.created.id });
  expect(registered.resource.producer.children).toHaveLength(2);
  expect(registered.resource.producer.children.every((row: { identity: unknown; exitCode: number; observedClosed: boolean }) =>
    row.identity && row.exitCode === 0 && row.observedClosed)).toBe(true);
  const evidence = ['source-evidence.json', 'stop-evidence.json'].map(name => path.join(input.root, name));
  await writeFile(evidence[0], JSON.stringify(registered.resource.revision));
  await writeFile(evidence[1], JSON.stringify(registered.resource.producer));
  const adopted = await input.cli('adopt', '--workspace', input.workspace, '--repository', input.repo,
    '--worktree-id', input.created.id, '--intent', 'Preserve the owned fixture output',
    '--evidence', evidence[0], '--evidence', evidence[1]);
  expect(adopted.resource.state).toBe('adopted');
  expect(adopted.resource.bankCapture.state).toBe('verified');
  const journals = await input.cold(`
    const ns = await import(${JSON.stringify(pathToFileURL(path.join(source, 'src/lib/db/index.ts')).href)});
    const { getSqlite } = ns.default ?? ns;
    const rows = getSqlite().prepare('SELECT phase, observed_closed, exit_code, receipt_json FROM workspace_generated_output_bank_entries WHERE resource_id = ?').all(${JSON.stringify(id)});
    console.log('O8_GENERATED_RESULT ' + JSON.stringify(rows));
  `) as Array<{ phase: string; observed_closed: number; exit_code: number; receipt_json: string }>;
  expect(journals.length).toBeGreaterThan(1);
  expect(journals.every(row => row.phase === 'complete' && row.observed_closed === 1 && row.exit_code === 0
    && JSON.parse(row.receipt_json).processIdentity)).toBe(true);
  const recovered = await input.cli('recover', '--resource', id);
  expect(recovered.resource.recovery.state).toBe('complete');
  expect(recovered.resource.recovery.purpose).toBe('recovery');
  expect(recovered.resource.recovery.ownerPid).toBeGreaterThan(0);
  expect(recovered.resource.recovery.ownerIdentity.version).toBe(1);
  const restoredJournal = await input.cold(`
    const ns = await import(${JSON.stringify(pathToFileURL(path.join(source, 'src/lib/db/index.ts')).href)});
    const { getSqlite } = ns.default ?? ns;
    const rows = getSqlite().prepare('SELECT kind, phase, observed_closed, exit_code, receipt_json FROM workspace_generated_output_recovery_entries WHERE resource_id = ?').all(${JSON.stringify(id)});
    console.log('O8_GENERATED_RESULT ' + JSON.stringify(rows));
  `) as Array<{ kind: string; phase: string; observed_closed: number; exit_code: number; receipt_json: string }>;
  expect(restoredJournal.every(row => row.phase === 'complete' && row.observed_closed === 1 && row.exit_code === 0)).toBe(true);
  expect(restoredJournal.filter(row => row.kind === 'file').every(row => JSON.parse(row.receipt_json).processIdentity)).toBe(true);
  const history = await input.cold(`
    const state = await import(${JSON.stringify(pathToFileURL(path.join(source, 'src/lib/workspace/generated-output-state.ts')).href)});
    const { readGeneratedOutputResource, saveGeneratedOutputResource } = state.default ?? state;
    const database = await import(${JSON.stringify(pathToFileURL(path.join(source, 'src/lib/db/index.ts')).href)});
    const { getSqlite } = database.default ?? database;
    const { randomUUID } = await import('node:crypto');
    const resource = readGeneratedOutputResource(${JSON.stringify(id)});
    const before = JSON.stringify(resource); const errors = [];
    const operationId = randomUUID();
    const newCopy = { ...resource.recovery, operationId, path: resource.recovery.parent.canonicalPath + '/' + operationId,
      state: 'planned', root: null, completedAt: undefined };
    for (const recovery of [{ ...resource.recovery, purpose: 'verification-disposable' }, undefined, newCopy]) {
      try { saveGeneratedOutputResource(resource, { recovery }); errors.push('unexpected success'); }
      catch (error) { errors.push(error.message); }
      if (JSON.stringify(readGeneratedOutputResource(resource.resourceId)) !== before) throw new Error('Refusal changed durable resource state');
    }
    const rows = getSqlite().prepare('SELECT purpose, state, payload_json FROM workspace_generated_output_recoveries WHERE resource_id = ?').all(resource.resourceId);
    console.log('O8_GENERATED_RESULT ' + JSON.stringify({ errors, rows }));
  `) as { errors: string[]; rows: Array<{ purpose: string; state: string; payload_json: string }> };
  expect(history.errors[0]).toContain('immutable creation');
  expect(history.errors[1]).toContain('cannot be discarded');
  expect(history.errors[2]).toContain('new planned operation after recorded retirement');
  expect(history.rows).toHaveLength(1);
  expect(history.rows[0].purpose).toBe('recovery');
  expect(history.rows[0].state).toBe('complete');
  expect(JSON.parse(history.rows[0].payload_json)).toEqual(recovered.resource.recovery);
  await expect(input.cli('recover-verification', '--resource', id)).rejects.toThrow('Existing recovery creation purpose cannot be changed');
  const recoveredPath = recovered.resource.recovery.path;
  expect(await readFile(path.join(recoveredPath, 'cache/proof.bin'), 'utf8')).toBe('native generated fixture bytes');
  const recoveredIdentity = await lstat(recoveredPath);
  await rename(input.workspace, path.join(path.dirname(input.workspace), 'fixture-source-held'));
  const replay = await input.cli('recover', '--resource', id);
  expect(replay.resource.recovery).toEqual(recovered.resource.recovery);
  expect((await lstat(recoveredPath)).ino).toBe(recoveredIdentity.ino);
  expect((await input.cli('status', '--resource', id)).resource.recovery.state).toBe('complete');
}, 180_000);

it('allows an unmanaged checkout to rerun a failed build without granting lifecycle ownership', async () => {
  const root = await createRetainedGeneratedOutputFixture('o8-unmanaged-build-');
  const repo = path.join(root, 'repo'); const data = path.join(root, 'data');
  await mkdir(repo); await mkdir(data, { mode: 0o700 });
  await writeFile(path.join(repo, 'package.json'), '{"private":true}\n');
  await mkdir(path.join(repo, 'scripts'));
  await writeFile(path.join(repo, 'scripts/bust-stale-patch-cache.mjs'),
    await readFile(path.join(source, 'scripts/bust-stale-patch-cache.mjs')));
  await exec('git', ['init', '--initial-branch=main'], { cwd: repo });
  const next = path.join(repo, 'node_modules/next/dist/bin');
  await mkdir(next, { recursive: true });
  await writeFile(path.join(next, 'next'), `
    const fs = require('node:fs'); fs.mkdirSync('.next', { recursive: true });
    fs.writeFileSync('.next/proof.txt', process.env.FIXTURE_BUILD_FAILURE ? 'failed' : 'complete');
    process.exit(process.env.FIXTURE_BUILD_FAILURE ? 7 : 0);
  `);
  const env = { ...process.env, O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
    CORTEX_IDE_DB_PATH: path.join(data, 'fixture.db'), TSX_TSCONFIG_PATH: path.join(source, 'tsconfig.json') };
  const run = (fail: boolean) => exec(process.execPath, [path.join(source, 'scripts/build.mjs')], {
    cwd: repo, env: fail ? { ...env, FIXTURE_BUILD_FAILURE: '1' } : env, timeout: 30_000,
  });
  await expect(run(true)).rejects.toMatchObject({ code: 7 });
  expect(await readFile(path.join(repo, '.next/proof.txt'), 'utf8')).toBe('failed');
  await run(false);
  expect(await readFile(path.join(repo, '.next/proof.txt'), 'utf8')).toBe('complete');
  await expect(lstat(path.join(repo, '.o8-generated-output-store'))).rejects.toMatchObject({ code: 'ENOENT' });
  const Database = require('better-sqlite3');
  const database = new Database(env.CORTEX_IDE_DB_PATH, { readonly: true });
  try {
    expect(database.prepare('SELECT COUNT(*) AS count FROM workspace_generated_outputs').get().count).toBe(0);
  } finally { database.close(); }
}, 60_000);

it('holds managed failed output until an explicit bank preserves its real closed failure receipts', async () => {
  const input = await fixture();
  const next = path.join(input.workspace, 'node_modules/next/dist/bin');
  await mkdir(next, { recursive: true });
  await writeFile(path.join(next, 'next'), `
    const fs = require('node:fs'); fs.mkdirSync('.next/cache', { recursive: true });
    fs.writeFileSync('.next/cache/failure.bin', 'preserve actual failed output'); process.exit(7);
  `);
  const build = () => exec(process.execPath, [path.join(source, 'scripts/build.mjs')], {
    cwd: input.workspace, env: input.env, timeout: 30_000, maxBuffer: 1024 ** 2,
  });
  await expect(build()).rejects.toMatchObject({ code: 7 });
  const failed = await input.cli('register', '--workspace', input.workspace);
  expect(failed.resource.state).toBe('failed-held');
  expect(failed.resource.producer.children).toHaveLength(2);
  expect(failed.resource.producer.children.every((row: { identity: unknown; observedClosed: boolean }) =>
    row.identity && row.observedClosed)).toBe(true);
  expect(failed.resource.producer.children.at(-1).exitCode).toBe(7);
  await expect(build()).rejects.toThrow('unresolved producer or retention authority');
  expect(await readFile(path.join(input.workspace, '.next/cache/failure.bin'), 'utf8')).toBe('preserve actual failed output');
  const evidence = ['failed-source.json', 'failed-stop.json'].map(name => path.join(input.root, name));
  await writeFile(evidence[0], JSON.stringify(failed.resource.revision));
  await writeFile(evidence[1], JSON.stringify(failed.resource.producer));
  const adopted = await input.cli('adopt', '--workspace', input.workspace, '--repository', input.repo,
    '--worktree-id', input.created.id, '--intent', 'Bank the observed closed failed fixture output',
    '--evidence', evidence[0], '--evidence', evidence[1]);
  expect(adopted.resource.state).toBe('adopted');
  const status = await input.cli('status', '--resource', failed.resource.resourceId);
  expect(status.resource.producer).toEqual(failed.resource.producer);
  const adoption = await input.cold(`
    const ns = await import(${JSON.stringify(pathToFileURL(path.join(source, 'src/lib/workspace/generated-output-state.ts')).href)});
    const { readGeneratedOutputResource } = ns.default ?? ns;
    console.log('O8_GENERATED_RESULT ' + JSON.stringify(readGeneratedOutputResource(${JSON.stringify(failed.resource.resourceId)}).adoption));
  `) as { producerOutcome: string };
  expect(adoption.producerOutcome).toBe('terminal-failure');
  const recovered = await input.cli('recover', '--resource', failed.resource.resourceId);
  expect(await readFile(path.join(recovered.resource.recovery.path, 'cache/failure.bin'), 'utf8'))
    .toBe('preserve actual failed output');
}, 150_000);
