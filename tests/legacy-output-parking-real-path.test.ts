import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { buildPiWriteHelper } from './helpers/pi-write-helper';
import { createRetainedGeneratedOutputFixture } from './generated-output-fixture';

const source = process.cwd(); const require = createRequire(import.meta.url);
let compiled: string;
async function fixture() {
  compiled ??= buildPiWriteHelper({ hooks: true });
  const root = await createRetainedGeneratedOutputFixture('o8-legacy-parking-');
  const primary = path.join(root, 'primary'); const workspace = path.join(root, 'linked');
  const data = path.join(root, 'data'); const bin = path.join(root, 'bin');
  for (const directory of [primary, data, bin]) mkdirSync(directory, { mode: 0o700 });
  writeFileSync(path.join(primary, '.gitignore'), '.next\n.o8-generated-output-store\n.o8-retained-legacy-*\n');
  for (const args of [['init', '--initial-branch=main'], ['add', '.'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture'], ['worktree', 'add', '-b', 'fixture-linked', workspace]]) {
    const result = spawnSync('git', args, { cwd: primary, encoding: 'utf8' }); expect(result.status, result.stderr).toBe(0);
  }
  const output = path.join(workspace, '.next'); mkdirSync(path.join(output, 'dev'), { recursive: true });
  writeFileSync(path.join(output, 'proof'), 'intact retained legacy bytes');
  const stopped = spawnSync(process.execPath, ['-e', 'process.exit(0)']); expect(stopped.status).toBe(0);
  const lock = JSON.stringify({ pid: stopped.pid, startedAt: Date.now() });
  writeFileSync(path.join(output, 'dev/lock'), lock);
  const evidence = [path.join(root, 'source-evidence.json'), path.join(root, 'stop-evidence.json')];
  writeFileSync(evidence[0], JSON.stringify({ workspace, output: lstatSync(output).ino }));
  writeFileSync(evidence[1], JSON.stringify({ pid: stopped.pid, observedClose: true, exit: stopped.status }));
  const helper = path.join(bin, 'o8-pi-write'); copyFileSync(compiled, helper);
  const hook = path.join(bin, 'hook');
  const probes = path.join(root, 'native-cwd-probes'); mkdirSync(probes, { mode: 0o700 });
  const env = { ...process.env, O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
    CORTEX_IDE_DB_PATH: path.join(data, 'fixture.db'), O8_PI_WRITE_BIN: helper,
    O8_TEST_NATIVE_CWD_PROBE_ROOT: probes, TSX_TSCONFIG_PATH: path.join(source, 'tsconfig.json'),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(path.join(source, 'tests/generated-output-native-cwd-observer.mjs')).href}`].filter(Boolean).join(' ') };
  let sequence = 0;
  function invoke(args: string[], extra: Partial<NodeJS.ProcessEnv> = {}) {
    const result = spawnSync(process.execPath, args, { cwd: root, env: { ...env, ...extra },
      encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 ** 2 });
    writeFileSync(path.join(root, `command-${++sequence}.json`), JSON.stringify({ args, pid: result.pid,
      exit: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }, null, 2));
    return result;
  }
  const cli = (...args: string[]) => invoke([path.join(source, 'scripts/generated-output.mjs'), ...args]);
  const cold = (script: string) => invoke(['--import', path.join(source, 'scripts/register-server-only-stub.mjs'),
    '--import', require.resolve('tsx'), '--input-type=module', '-e', script]);
  const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(path.join(source, name)).href);
  const park = (extra: Partial<NodeJS.ProcessEnv> = {}) => invoke([path.join(source, 'scripts/generated-output.mjs'),
    'park-legacy', '--workspace', workspace, '--intent', 'Retain intact legacy fixture output',
    ...evidence.flatMap(value => ['--evidence', value])], extra);
  const rows = () => {
    const db = new Database(path.join(data, 'fixture.db'), { readonly: true });
    try { return db.prepare('SELECT payload_json FROM workspace_legacy_output_parks ORDER BY rowid').all()
      .map(row => JSON.parse((row as { payload_json: string }).payload_json)); } finally { db.close(); }
  };
  function scriptHook(body: string) { writeFileSync(hook, `#!${process.execPath}\n${body}\n`, { mode: 0o700 }); }
  function success(result: ReturnType<typeof cli>) { expect(result.status, result.stderr + result.stdout).toBe(0); return JSON.parse(result.stdout.trim().split('\n').at(-1)!).legacy[0]; }
  return { root, workspace, output, data, hook, helper, env, evidence, lock, cli, cold, moduleUrl, park, rows, scriptHook, success };
}

it('preserves native legacy parking, refuses raced/replaced destinations, and cold-replays restoration', async () => {
  const f = await fixture(); const identity = lstatSync(f.output);
  // Real process with cwd inside the linked workspace must prevent parking.
  const live = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], { cwd: f.workspace });
  const closed = once(live, 'close'); let ready = ''; live.stdout.on('data', value => { ready += value; });
  try {
    await vi.waitFor(() => expect(ready).toBe('ready'));
    const refused = f.park(); expect(refused.status).not.toBe(0); expect(refused.stderr).toContain('live or inconclusive');
    expect(lstatSync(f.output).ino).toBe(identity.ino);
  } finally { live.kill('SIGTERM'); await closed; }
  // Deterministic same race as the retained red fixture, now at the atomic native seam.
  const raceReceipt = path.join(f.root, 'contender.json');
  f.scriptHook(`if(process.argv[2]==='directory-before-rename') {
    const fs=require('node:fs');const Database=require(${JSON.stringify(require.resolve('better-sqlite3'))});
    const db=new Database(${JSON.stringify(path.join(f.data, 'fixture.db'))},{readonly:true});
    const row=JSON.parse(db.prepare("SELECT payload_json FROM workspace_legacy_output_parks WHERE state='prepared'").get().payload_json);db.close();
    fs.mkdirSync(row.retainedPath);const s=fs.lstatSync(row.retainedPath);
    fs.writeFileSync(${JSON.stringify(raceReceipt)},JSON.stringify({device:s.dev,inode:s.ino,path:row.retainedPath}));
  }`);
  const raced = f.park(); expect(raced.status).not.toBe(0); expect(raced.stderr).toContain('Directory move refused');
  let record = f.rows()[0]; const contender = JSON.parse(readFileSync(raceReceipt, 'utf8'));
  expect(record.state).toBe('prepared'); expect(lstatSync(record.retainedPath).ino).toBe(contender.inode);
  expect(lstatSync(f.output).ino).toBe(identity.ino);
  expect(f.cli('resume-legacy', '--operation', record.operationId).status).not.toBe(0);
  // Retain the test-created empty contender; no product command grants this action.
  renameSync(record.retainedPath, path.join(f.root, 'retained-contender'));
  renameSync(f.hook, path.join(f.root, 'race-hook-disabled'));
  // A replacement source cannot inherit the prior journal's identity.
  renameSync(f.output, path.join(f.root, 'original-held-for-test')); mkdirSync(f.output);
  const replaced = f.cli('resume-legacy', '--operation', record.operationId);
  expect(replaced.status).not.toBe(0); expect(replaced.stderr).toContain('replaced or ambiguous');
  renameSync(f.output, path.join(f.root, 'replacement-retained'));
  renameSync(path.join(f.root, 'original-held-for-test'), f.output);
  record = f.success(f.cli('resume-legacy', '--operation', record.operationId));
  expect(record.state).toBe('parked'); expect(record.reclaimedBytes).toBe(0);
  expect(existsSync(f.output)).toBe(false); expect(lstatSync(record.retainedPath).ino).toBe(identity.ino);
  expect(readFileSync(path.join(record.retainedPath, 'dev/lock'), 'utf8')).toBe(f.lock);
  const retainedGuard = f.cold(`const ns=await import(${f.moduleUrl('src/lib/workspace/retention-holds.ts')});
    const {assertWorkspaceRetentionReleased}=ns.default??ns;
    assertWorkspaceRetentionReleased(${JSON.stringify(record.retainedPath)},${JSON.stringify(record.output)});`);
  expect(retainedGuard.status).not.toBe(0); expect(retainedGuard.stderr).toContain('not disposable');
  // A new destination, even empty, is never replaced during restore.
  mkdirSync(f.output); const newcomer = lstatSync(f.output);
  const occupied = f.cli('restore-legacy', '--operation', record.operationId);
  expect(occupied.status).not.toBe(0); expect(occupied.stderr).toContain('occupied');
  expect(lstatSync(f.output).ino).toBe(newcomer.ino);
  renameSync(f.output, path.join(f.root, 'newcomer-retained'));
  writeFileSync(path.join(record.retainedPath, 'proof'), 'changed legacy bytes');
  const changed = f.cli('restore-legacy', '--operation', record.operationId);
  expect(changed.status).not.toBe(0); expect(f.rows()[0].state).toBe('parked');
  writeFileSync(path.join(record.retainedPath, 'proof'), 'intact retained legacy bytes');
  // Mutation completes but native receipt is interrupted: journal remains restoring.
  f.scriptHook("if(process.argv[2]==='directory-after-rename') process.kill(Number(process.argv[3]),'SIGKILL');");
  const interrupted = f.cli('restore-legacy', '--operation', record.operationId);
  expect(interrupted.status).not.toBe(0); expect(f.rows()[0].state).toBe('restoring');
  expect(lstatSync(f.output).ino).toBe(identity.ino); expect(existsSync(record.retainedPath)).toBe(false);
  renameSync(f.hook, path.join(f.root, 'interrupt-hook-disabled'));
  record = f.success(f.cli('resume-legacy', '--operation', record.operationId));
  expect(record.state).toBe('restored'); expect(readFileSync(path.join(f.output, 'proof'), 'utf8')).toBe('intact retained legacy bytes');
  expect(readFileSync(path.join(f.output, 'dev/lock'), 'utf8')).toBe(f.lock);
  // A separate fresh generation may run after parking; legacy history stays retained.
  f.scriptHook("if(process.argv[2]==='directory-after-rename') process.kill(Number(process.argv[3]),'SIGKILL');");
  expect(f.park().status).not.toBe(0);
  record = f.rows()[1]; expect(record.state).toBe('prepared'); expect(existsSync(f.output)).toBe(false);
  renameSync(f.hook, path.join(f.root, 'park-interrupt-hook-disabled'));
  const pending = f.cold(`const ns=await import(${f.moduleUrl('src/lib/workspace/generated-output-producer.ts')});
    const {runGeneratedOutputPrebuild}=ns.default??ns;
    await runGeneratedOutputPrebuild({workspacePath:${JSON.stringify(f.workspace)},preflight(){},operation:async()=>0});`);
  expect(pending.status).not.toBe(0); expect(pending.stderr).toContain('pending legacy');
  record = f.success(f.cli('resume-legacy', '--operation', record.operationId));
  const built = f.cold(`const ns=await import(${f.moduleUrl('src/lib/workspace/generated-output-producer.ts')});
    const {runGeneratedOutputPrebuild}=ns.default??ns;
    const code=await runGeneratedOutputPrebuild({workspacePath:${JSON.stringify(f.workspace)},preflight(){},
      operation:ctx=>ctx.runBuild(run=>run(process.execPath,['-e',"require('node:fs').writeFileSync('.next/new-generation','fresh')"]))});
    if(code!==0)process.exit(code);`);
  expect(built.status, built.stderr).toBe(0);
  expect(f.cli('restore-legacy', '--operation', record.operationId).status).not.toBe(0);
  const db = new Database(path.join(f.data, 'fixture.db'), { readonly: true });
  const generation = JSON.parse((db.prepare('SELECT payload_json FROM workspace_generated_outputs').get() as { payload_json: string }).payload_json); db.close();
  expect(generation.state).toBe('succeeded'); expect(generation.output.inode).not.toBe(identity.ino);
  renameSync(f.output, path.join(f.root, 'new-generation-held-for-test'));
  const missingGeneration = f.cli('restore-legacy', '--operation', record.operationId);
  expect(missingGeneration.status).not.toBe(0); expect(missingGeneration.stderr).toContain('registered output generations');
  renameSync(path.join(f.root, 'new-generation-held-for-test'), f.output);
  expect(f.rows().map(row => row.state)).toEqual(['restored', 'parked']);
  expect(lstatSync(record.retainedPath).ino).toBe(identity.ino);
  writeFileSync(path.join(f.root, 'product-state.json'), JSON.stringify({ legacy: f.rows(), generation, contender, newcomer: newcomer.ino }, null, 2));
}, 600_000);

it('refuses unknown lock evidence, missing native capability and persisted holds without losing legacy bytes', async () => {
  const f = await fixture(); const identity = lstatSync(f.output);
  const unavailable = path.join(f.root, 'unavailable-probe'); mkdirSync(unavailable);
  writeFileSync(path.join(unavailable, 'lsof'), `#!${process.execPath}\nprocess.stderr.write('fixture unavailable');process.exit(2);\n`, { mode: 0o700 });
  const uncertain = f.park({ PATH: unavailable + path.delimiter + process.env.PATH });
  expect(uncertain.status).not.toBe(0); expect(uncertain.stderr).toContain('inconclusive process');
  writeFileSync(path.join(f.output, 'dev/lock'), 'unknown lock format');
  const unknown = f.park(); expect(unknown.status).not.toBe(0); expect(unknown.stderr).toContain('inconclusive');
  writeFileSync(path.join(f.output, 'dev/lock'), f.lock);
  renameSync(f.helper, path.join(f.root, 'native-helper-retained'));
  const missing = f.park(); expect(missing.status).not.toBe(0); expect(missing.stderr).toContain('helper is missing');
  const record = f.rows()[0]; expect(record.state).toBe('prepared'); expect(lstatSync(f.output).ino).toBe(identity.ino);
  renameSync(path.join(f.root, 'native-helper-retained'), f.helper);
  f.success(f.cli('resume-legacy', '--operation', record.operationId));
  // A later independent hold remains intact and refuses restoration.
  const held = f.cold(`const ns=await import(${f.moduleUrl('src/lib/workspace/retention-holds.ts')});
    const {acquireWorkspaceRetentionHold}=ns.default??ns;
    acquireWorkspaceRetentionHold({repositoryPath:${JSON.stringify(f.workspace)},repositoryUuid:'fixture',worktreeId:'legacy',
      packetId:'fixture',laneId:'fixture',holdId:'fixture-hold',reason:'Retain native legacy proof',
      identity:${JSON.stringify({ ...record.output, canonicalPath: record.retainedPath })}});`);
  expect(held.status, held.stderr).toBe(0);
  const refused = f.cli('restore-legacy', '--operation', record.operationId);
  expect(refused.status).not.toBe(0); expect(refused.stderr).toContain('retention hold');
  expect(lstatSync(record.retainedPath).ino).toBe(identity.ino);
  expect(f.rows()[0].state).toBe('parked');
  writeFileSync(path.join(f.root, 'product-state.json'), JSON.stringify({ legacy: f.rows(), held: true }, null, 2));
}, 300_000);
