import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
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
  writeFileSync(path.join(primary, '.gitignore'), '.next\n.o8-generated-output-store\n.o8-retained-legacy-*\n.o8-retained-prebuild-*\n');
  for (const args of [['init', '--initial-branch=main'], ['add', '.'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture'], ['worktree', 'add', '-b', 'fixture-linked', workspace]]) {
    const result = spawnSync('git', args, { cwd: primary, encoding: 'utf8' }); expect(result.status, result.stderr).toBe(0);
  }
  const output = path.join(workspace, '.next'); mkdirSync(path.join(output, 'dev'), { recursive: true });
  writeFileSync(path.join(output, 'proof'), 'intact retained legacy bytes');
  const links = [
    ['dev/node_modules/better-sqlite3-90e2652d1716b047', '../../../node_modules/better-sqlite3'],
    ['dev/node_modules/@earendil-works/pi-ai-5e96b54476ded9ea', '../../../../node_modules/@earendil-works/pi-ai'],
  ].map(([relative, target]) => {
    const leaf = path.join(output, relative); mkdirSync(path.dirname(leaf), { recursive: true });
    const dependency = path.resolve(path.dirname(leaf), target); mkdirSync(dependency, { recursive: true });
    const sentinel = path.join(dependency, 'sentinel'); writeFileSync(sentinel, 'untouched dependency bytes');
    symlinkSync(target, leaf); const node = lstatSync(leaf);
    return { relative, target, sentinel, device: node.dev, inode: node.ino };
  });
  function assertLinks(directory: string) {
    for (const link of links) {
      const leaf = path.join(directory, link.relative); const node = lstatSync(leaf);
      expect(node.isSymbolicLink()).toBe(true); expect(node.dev).toBe(link.device); expect(node.ino).toBe(link.inode);
      expect(readlinkSync(leaf)).toBe(link.target);
      expect(readFileSync(link.sentinel, 'utf8')).toBe('untouched dependency bytes');
    }
  }
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
  return { root, workspace, output, data, hook, helper, env, evidence, lock, links, assertLinks, cli, cold, moduleUrl, park, rows, scriptHook, success };
}

it('retains terminal failed prebuild bytes and history before admitting a linked fresh generation', async () => {
  const f = await fixture();
  const legacy = f.success(f.park());
  const build = (exit: number) => f.cold(`const ns=await import(${f.moduleUrl('src/lib/workspace/generated-output-producer.ts')});
    const {runGeneratedOutputPrebuild}=ns.default??ns;
    process.chdir(${JSON.stringify(f.workspace)});
    const code=await runGeneratedOutputPrebuild({workspacePath:${JSON.stringify(f.workspace)},preflight(){},
      operation:ctx=>ctx.runBuild(run=>run(process.execPath,['-e',
        "require('node:fs').writeFileSync('.next/proof','generation-${exit}');process.exit(${exit})"]))});
    process.exitCode=code;`);
  const failed = build(17); expect(failed.status, failed.stderr).toBe(17);
  const resources = () => {
    const db = new Database(path.join(f.data, 'fixture.db'), { readonly: true });
    try { return db.prepare('SELECT payload_json FROM workspace_generated_outputs ORDER BY rowid').all()
      .map(row => JSON.parse((row as { payload_json: string }).payload_json)); } finally { db.close(); }
  };
  const original = resources()[0]; const identity = lstatSync(f.output);
  expect(original.state).toBe('failed-held'); expect(original.attempt.children.at(-1).exitCode).toBe(17);
  expect(build(0).status).not.toBe(0);
  // Exercise additive migration of an already populated pre-continuation store.
  const previousDb = new Database(path.join(f.data, 'fixture.db'));
  previousDb.exec(`DROP INDEX idx_generated_output_current;
    ALTER TABLE workspace_generated_outputs DROP COLUMN retained_operation_id;
    CREATE UNIQUE INDEX idx_generated_output_current ON workspace_generated_outputs(workspace_path) WHERE state != 'retired';`);
  previousDb.close();
  const retained = f.cli('park-failed-prebuild', '--resource', original.resourceId,
    '--intent', 'Preserve terminal failed prebuild before retry', ...f.evidence.flatMap(value => ['--evidence', value]));
  expect(retained.status, retained.stderr).toBe(0);
  const record = JSON.parse(retained.stdout.trim().split('\n').at(-1)!).retention;
  expect(record.state).toBe('parked'); expect(record.reclaimedBytes).toBe(0);
  expect(lstatSync(record.retainedPath).ino).toBe(identity.ino); expect(existsSync(f.output)).toBe(false);
  expect(readFileSync(path.join(record.retainedPath, 'proof'), 'utf8')).toBe('generation-17');
  expect(resources()).toEqual([original]);
  const marker = path.join(f.workspace, '.o8-generated-output-store'); const savedMarker = path.join(f.root, 'retained-store-binding');
  renameSync(marker, savedMarker);
  expect(f.cli('register', '--workspace', f.workspace).status).not.toBe(0);
  expect(existsSync(marker)).toBe(false); expect(build(0).status).not.toBe(0);
  renameSync(savedMarker, marker);
  writeFileSync(path.join(record.retainedPath, 'proof'), 'changed retained generation');
  expect(build(0).status).not.toBe(0); expect(resources()).toEqual([original]);
  writeFileSync(path.join(record.retainedPath, 'proof'), 'generation-17');
  const fresh = build(0); expect(fresh.status, fresh.stderr).toBe(0);
  const [old, next] = resources(); expect(old).toEqual(original); expect(next.state).toBe('succeeded');
  expect(next.continuedFrom).toEqual({ resourceId: original.resourceId, operationId: record.operationId });
  expect(next.output.inode).not.toBe(identity.ino);
  const preflight = spawnSync(process.execPath, [path.join(source, 'scripts/preship-cleanup.mjs')],
    { cwd: f.workspace, env: f.env, encoding: 'utf8', timeout: 30_000 });
  expect(preflight.status, preflight.stderr).toBe(0);
  const replay = f.cli('resume-failed-prebuild', '--operation', record.operationId);
  expect(replay.status, replay.stderr).toBe(0); expect(resources()).toEqual([old, next]);
  expect(readFileSync(path.join(record.retainedPath, 'proof'), 'utf8')).toBe('generation-17');
  f.assertLinks(legacy.retainedPath);
  writeFileSync(path.join(f.root, 'failed-prebuild-state.json'), JSON.stringify({ original, record, next }, null, 2));
}, 300_000);

it('refuses unsafe failed prebuild movement and cold-resumes an interrupted exact retention', async () => {
  const f = await fixture(); f.success(f.park());
  const failed = f.cold(`const ns=await import(${f.moduleUrl('src/lib/workspace/generated-output-producer.ts')});
    process.exitCode=await (ns.default??ns).runGeneratedOutputPrebuild({workspacePath:${JSON.stringify(f.workspace)},preflight(){},
      operation:ctx=>ctx.runBuild(run=>run(process.execPath,['-e',"require('node:fs').writeFileSync('.next/proof','failed bytes');process.exit(19)"]))});`);
  expect(failed.status, failed.stderr).toBe(19);
  const db = new Database(path.join(f.data, 'fixture.db'));
  const original = JSON.parse((db.prepare('SELECT payload_json FROM workspace_generated_outputs').get() as { payload_json: string }).payload_json);
  const rows = () => db.prepare('SELECT payload_json FROM workspace_failed_prebuild_parks').all()
    .map(row => JSON.parse((row as { payload_json: string }).payload_json));
  const park = () => f.cli('park-failed-prebuild', '--resource', original.resourceId, '--intent', 'Retain failed fixture',
    ...f.evidence.flatMap(value => ['--evidence', value]));
  const refused = (message: string) => { const result = park(); expect(result.status).not.toBe(0); expect(result.stderr).toContain(message); };
  try {
    const unknown = structuredClone(original); unknown.attempt.children[0].observedClosed = false;
    unknown.attempt.children[0].exitCode = null;
    db.prepare('UPDATE workspace_generated_outputs SET payload_json = ?').run(JSON.stringify(unknown));
    refused('complete terminal');
    db.prepare('UPDATE workspace_generated_outputs SET payload_json = ?').run(JSON.stringify(original));
    const marker = path.join(f.workspace, '.o8-generated-output-store'); const savedMarker = path.join(f.root, 'saved-marker');
    renameSync(marker, savedMarker); refused('store binding is missing'); renameSync(savedMarker, marker);
    const gitFile = path.join(f.workspace, '.git'); const savedGit = readFileSync(gitFile);
    writeFileSync(gitFile, 'gitdir: /nonexistent/fixture-admin\n');
    expect(park().status).not.toBe(0); writeFileSync(gitFile, savedGit);
    const live = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], { cwd: f.workspace });
    const closed = once(live, 'close'); let ready = ''; live.stdout.on('data', value => { ready += value; });
    try { await vi.waitFor(() => expect(ready).toBe('ready')); refused('live or inconclusive'); }
    finally { live.kill('SIGTERM'); await closed; }
    writeFileSync(path.join(f.output, 'lock'), 'unknown lock'); refused('inconclusive');
    renameSync(path.join(f.output, 'lock'), path.join(f.root, 'unknown-lock-retained'));
    const held = f.cold(`const ns=await import(${f.moduleUrl('src/lib/workspace/retention-holds.ts')});
      (ns.default??ns).acquireWorkspaceRetentionHold({repositoryPath:${JSON.stringify(f.workspace)},repositoryUuid:'fixture',worktreeId:'failed',
        packetId:'failed',laneId:'failed',holdId:'failed-hold',reason:'Keep failed fixture',identity:${JSON.stringify(original.output)}});`);
    expect(held.status, held.stderr).toBe(0); refused('retention hold');
    const released = f.cold(`const ns=await import(${f.moduleUrl('src/lib/workspace/retention-holds.ts')});
      (ns.default??ns).releaseWorkspaceRetentionHold({repositoryUuid:'fixture',packetId:'failed',holdId:'failed-hold'});`);
    expect(released.status, released.stderr).toBe(0);
    db.prepare(`INSERT INTO workspace_exact_claims (kind,repository_path,worktree_id,operation_id,expected_path,source_path,claim_path,state,
      parent_device,parent_inode,parent_canonical_path,source_device,source_inode,created_at,updated_at)
      VALUES ('generated-output-retirement',?,?,?,?,?,?,'prepared',?,?,?,?,?,?,?)`).run(f.workspace, original.resourceId,
      'fixture-claim', f.output, f.output, path.join(f.workspace, '.fixture-claim'), original.workspace.device, original.workspace.inode,
      f.workspace, original.output.device, original.output.inode, Date.now(), Date.now());
    refused('exact workspace claim');
    db.prepare("DELETE FROM workspace_exact_claims WHERE operation_id = 'fixture-claim'").run();
    expect(rows()).toEqual([]);
    f.scriptHook(`if(process.argv[2]==='directory-before-rename') {
      const fs=require('node:fs');const D=require(${JSON.stringify(require.resolve('better-sqlite3'))});
      const d=new D(${JSON.stringify(path.join(f.data, 'fixture.db'))},{readonly:true});
      const r=JSON.parse(d.prepare('SELECT payload_json FROM workspace_failed_prebuild_parks').get().payload_json);d.close();fs.mkdirSync(r.retainedPath);
    }`);
    refused('Directory move refused'); let record = rows()[0]; expect(record.state).toBe('prepared');
    expect(f.cli('resume-failed-prebuild', '--operation', record.operationId).status).not.toBe(0);
    renameSync(record.retainedPath, path.join(f.root, 'failed-contender-retained'));
    renameSync(f.hook, path.join(f.root, 'failed-race-hook-retained'));
    renameSync(f.output, path.join(f.root, 'failed-original-held')); mkdirSync(f.output);
    expect(f.cli('resume-failed-prebuild', '--operation', record.operationId).status).not.toBe(0);
    renameSync(f.output, path.join(f.root, 'failed-replacement-held')); renameSync(path.join(f.root, 'failed-original-held'), f.output);
    writeFileSync(path.join(f.output, 'proof'), 'tampered bytes');
    expect(f.cli('resume-failed-prebuild', '--operation', record.operationId).status).not.toBe(0);
    writeFileSync(path.join(f.output, 'proof'), 'failed bytes');
    const evidence = readFileSync(f.evidence[1]); writeFileSync(f.evidence[1], 'tampered evidence');
    expect(f.cli('resume-failed-prebuild', '--operation', record.operationId).status).not.toBe(0);
    writeFileSync(f.evidence[1], evidence);
    f.scriptHook("if(process.argv[2]==='directory-after-rename') process.kill(Number(process.argv[3]),'SIGKILL');");
    expect(f.cli('resume-failed-prebuild', '--operation', record.operationId).status).not.toBe(0);
    expect(rows()[0].state).toBe('prepared'); expect(existsSync(f.output)).toBe(false);
    const pending = f.cold(`const ns=await import(${f.moduleUrl('src/lib/workspace/generated-output-producer.ts')});
      await (ns.default??ns).runGeneratedOutputPrebuild({workspacePath:${JSON.stringify(f.workspace)},preflight(){},operation:async()=>0});`);
    expect(pending.status).not.toBe(0); expect(pending.stderr).toContain('pending failed prebuild');
    renameSync(f.hook, path.join(f.root, 'failed-interrupt-hook-retained'));
    const resumed = f.cli('resume-failed-prebuild', '--operation', record.operationId);
    expect(resumed.status, resumed.stderr).toBe(0); record = rows()[0]; expect(record.state).toBe('parked');
    expect(lstatSync(record.retainedPath).ino).toBe(original.output.inode);
    expect(JSON.parse((db.prepare('SELECT payload_json FROM workspace_generated_outputs').get() as { payload_json: string }).payload_json)).toEqual(original);
    const disposable = f.cold(`const ns=await import(${f.moduleUrl('src/lib/workspace/retention-holds.ts')});
      (ns.default??ns).assertWorkspaceRetentionReleased(${JSON.stringify(record.retainedPath)},${JSON.stringify(original.output)});`);
    expect(disposable.status).not.toBe(0); expect(disposable.stderr).toContain('not disposable');
    writeFileSync(path.join(f.root, 'failed-prebuild-guards.json'), JSON.stringify({ original, record }, null, 2));
  } finally { db.close(); }
}, 300_000);

it('preserves native legacy parking, refuses raced/replaced destinations, and cold-replays restoration', async () => {
  const f = await fixture(); const identity = lstatSync(f.output);
  const strictBank = f.cold(`const bank=await import(${f.moduleUrl('src/lib/workspace/generated-output-bank.ts')});
    const ids=await import(${f.moduleUrl('src/lib/worktree/materialization-identity.ts')});
    await (bank.default??bank).captureGeneratedOutputEntries(await (ids.default??ids).captureWorktreeMaterializationIdentity(${JSON.stringify(f.output)}));`);
  expect(strictBank.status).not.toBe(0); expect(strictBank.stderr).toContain('bank refuses links'); f.assertLinks(f.output);
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
  expect(record.state).toBe('parked'); expect(record.reclaimedBytes).toBe(0); f.assertLinks(record.retainedPath);
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
  // The same target text on a replacement inode cannot inherit the journal.
  const originalLink = path.join(record.retainedPath, f.links[0].relative);
  const savedLink = path.join(f.root, 'original-link-retained'); renameSync(originalLink, savedLink);
  symlinkSync(f.links[0].target, originalLink);
  const replacementLink = f.cli('restore-legacy', '--operation', record.operationId);
  expect(replacementLink.status).not.toBe(0); expect(replacementLink.stderr).toContain('node identity changed');
  renameSync(originalLink, path.join(f.root, 'replacement-link-retained'));
  symlinkSync('../../../node_modules/other', originalLink);
  const changedLink = f.cli('restore-legacy', '--operation', record.operationId);
  expect(changedLink.status).not.toBe(0); expect(changedLink.stderr).toContain('link target is unsafe');
  renameSync(originalLink, path.join(f.root, 'changed-link-retained')); renameSync(savedLink, originalLink);
  f.assertLinks(record.retainedPath); expect(f.rows()[0].state).toBe('parked');
  // Mutation completes but native receipt is interrupted: journal remains restoring.
  f.scriptHook("if(process.argv[2]==='directory-after-rename') process.kill(Number(process.argv[3]),'SIGKILL');");
  const interrupted = f.cli('restore-legacy', '--operation', record.operationId);
  expect(interrupted.status).not.toBe(0); expect(f.rows()[0].state).toBe('restoring');
  expect(lstatSync(f.output).ino).toBe(identity.ino); expect(existsSync(record.retainedPath)).toBe(false);
  renameSync(f.hook, path.join(f.root, 'interrupt-hook-disabled'));
  record = f.success(f.cli('resume-legacy', '--operation', record.operationId));
  f.assertLinks(f.output);
  expect(record.state).toBe('restored'); expect(readFileSync(path.join(f.output, 'proof'), 'utf8')).toBe('intact retained legacy bytes');
  expect(readFileSync(path.join(f.output, 'dev/lock'), 'utf8')).toBe(f.lock);
  // A separate fresh generation may run after parking; legacy history stays retained.
  f.scriptHook("if(process.argv[2]==='directory-after-rename') process.kill(Number(process.argv[3]),'SIGKILL');");
  expect(f.park().status).not.toBe(0);
  record = f.rows()[1]; f.assertLinks(record.retainedPath); expect(record.state).toBe('prepared'); expect(existsSync(f.output)).toBe(false);
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
  f.assertLinks(record.retainedPath);
  expect(f.rows().map(row => row.state)).toEqual(['restored', 'parked']);
  expect(lstatSync(record.retainedPath).ino).toBe(identity.ino);
  writeFileSync(path.join(f.root, 'product-state.json'), JSON.stringify({ legacy: f.rows(), links: f.links, generation, contender, newcomer: newcomer.ino }, null, 2));
}, 600_000);

it('refuses unknown lock evidence, missing native capability and persisted holds without losing legacy bytes', async () => {
  const f = await fixture(); const identity = lstatSync(f.output);
  const originalLink = path.join(f.output, f.links[0].relative);
  const savedLink = path.join(f.root, 'safe-link-retained'); renameSync(originalLink, savedLink);
  for (const [index, target] of ['/outside/dependency', '../../../../outside', '../../../node_modules/./better-sqlite3'].entries()) {
    symlinkSync(target, originalLink); const refused = f.park();
    expect(refused.status).not.toBe(0); expect(refused.stderr).toContain('link target is unsafe');
    expect(f.rows()).toEqual([]); renameSync(originalLink, path.join(f.root, `unsafe-link-${index}-retained`));
  }
  renameSync(savedLink, originalLink); f.assertLinks(f.output);
  // A redirected ancestor is a link node to refuse, never a directory to traverse.
  const modules = path.join(f.output, 'dev/node_modules'); const savedModules = path.join(f.root, 'original-modules-retained');
  renameSync(modules, savedModules); symlinkSync(savedModules, modules);
  const redirected = f.park(); expect(redirected.status).not.toBe(0); expect(redirected.stderr).toContain('link shape is unsafe');
  renameSync(modules, path.join(f.root, 'redirected-ancestor-retained')); renameSync(savedModules, modules); f.assertLinks(f.output);
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
  writeFileSync(path.join(f.root, 'product-state.json'), JSON.stringify({ legacy: f.rows(), links: f.links, held: true }, null, 2));
}, 300_000);
