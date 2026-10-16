import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import type { GeneratedOutputResource } from '../src/lib/workspace/generated-output-state';
import { createRetainedGeneratedOutputFixture } from './generated-output-fixture';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const source = process.cwd();
const url = (relative: string) => JSON.stringify(pathToFileURL(path.join(source, relative)).href);

async function fixture() {
  const root = await createRetainedGeneratedOutputFixture('o8-generated-parent-');
  const repo = path.join(root, 'repo'); const data = path.join(root, 'data');
  await mkdir(repo); await mkdir(data, { mode: 0o700 });
  await writeFile(path.join(repo, '.gitignore'), '.next\nnode_modules\n.o8-generated-output-store\n.o8-retired-generated-*\n');
  await writeFile(path.join(repo, 'package.json'), '{"private":true}\n');
  await mkdir(path.join(repo, 'scripts'));
  await writeFile(path.join(repo, 'scripts/bust-stale-patch-cache.mjs'),
    await readFile(path.join(source, 'scripts/bust-stale-patch-cache.mjs')));
  for (const args of [['init', '--initial-branch=main'], ['add', '.'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture']]) await exec('git', args, { cwd: repo });
  const probes = path.join(root, 'native-cwd-probes'); await mkdir(probes, { mode: 0o700 });
  const observer = pathToFileURL(path.join(source, 'tests/generated-output-native-cwd-observer.mjs')).href;
  const env = { ...process.env, O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
    CORTEX_IDE_DB_PATH: path.join(data, 'fixture.db'), TSX_TSCONFIG_PATH: path.join(source, 'tsconfig.json'),
    O8_WORKTREE_ROOT: path.join(root, 'worktrees'), CORTEX_IDE_OWNED_CODEX_ROOT: path.join(root, 'sessions'), O8_TEST_NATIVE_CWD_PROBE_ROOT: probes,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${observer}`].filter(Boolean).join(' ') };
  let commandIndex = 0;
  const invoke = async (args: string[], observe?: (chunk: string) => void) => {
    const execution = exec(process.execPath, args, { cwd: source, env, timeout: 120_000, maxBuffer: 4 * 1024 ** 2 });
    if (observe) execution.child.stdout!.on('data', chunk => observe(String(chunk)));
    const index = ++commandIndex; const startedAt = new Date().toISOString();
    const closed = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
      execution.child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    const save = async (stdout: string, stderr: string) => writeFile(path.join(root, `command-${index}.json`),
      JSON.stringify({ args, startedAt, closedAt: new Date().toISOString(), pid: execution.child.pid,
        nativeClose: await closed, stdout, stderr }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    try { const result = await execution; await save(result.stdout, result.stderr); return result; }
    catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string };
      await save(result.stdout ?? '', result.stderr ?? '');
      throw new Error(result.stderr?.trim() || 'Native fixture command failed without stderr', { cause: error });
    }
  };
  const cold = async (script: string, observe?: (chunk: string) => void) => {
    const result = await invoke(['--import', path.join(source, 'scripts/register-server-only-stub.mjs'),
      '--import', require.resolve('tsx'), '--input-type=module', '-e', script], observe);
    const match = /^O8_GENERATED_RESULT (.+)$/m.exec(result.stdout);
    if (!match) throw new Error(result.stdout + result.stderr);
    return { value: JSON.parse(match[1]), stderr: result.stderr };
  };
  const created = (await cold(`
    const ns = await import(${url('src/lib/worktree/manager.ts')}); const { WorktreeManager } = ns.default ?? ns;
    const entry = await new WorktreeManager(${JSON.stringify(repo)}).create({
      agentType: 'codex', taskName: 'Generated parent retention fixture', branchName: 'codex/generated-parent-fixture',
      baseBranch: 'main', managed: true, skipSetup: true });
    console.log('O8_GENERATED_RESULT ' + JSON.stringify(entry));
  `)).value as { id: string; path: string };
  const workspace = await realpath(created.path);
  const ownership = (await cold(`
    const repositories = await import(${url('src/lib/repos/registry.ts')}); const { addRepo } = repositories.default ?? repositories;
    const lanes = await import(${url('src/lib/lane/registry.ts')}); const { createLane, setLaneStatus } = lanes.default ?? lanes;
    const managers = await import(${url('src/lib/worktree/manager.ts')}); const { WorktreeManager } = managers.default ?? managers;
    const fs = await import('node:fs/promises'); const { randomUUID } = await import('node:crypto');
    const repo = await addRepo(${JSON.stringify(repo)}); const packetId = randomUUID();
    const surfaceId = 'codex-owned:codex-owned-' + packetId;
    const sessionDir = process.env.CORTEX_IDE_OWNED_CODEX_ROOT + '/codex-owned-' + packetId;
    await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const now = new Date().toISOString();
    // Truthful idle fixture ownership: no provider was launched and no provider completion is asserted.
    const session = { surfaceId, packetId, sessionDir, cwd: ${JSON.stringify(workspace)}, repoPath: ${JSON.stringify(workspace)},
      branch: 'codex/generated-parent-fixture', head: ${JSON.stringify((await exec('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim())},
      title: 'Owned generated parent fixture', createdAt: now, updatedAt: now, recentRuns: [],
      latestPrompt: 'Retain the owned fixture and verify parent cleanup refusal.', latestSummary: 'Idle fixture; zero provider executions.',
      runIdentityLedger: { version: 1, totalRuns: 0, complete: true },
      workspaceBinding: { logicalWorkspaceId: 'packet:' + packetId, repositoryUuid: repo.id, packetId,
        cwd: ${JSON.stringify(workspace)}, version: 1, verifiedAt: now } };
    await fs.writeFile(sessionDir + '/session.json', JSON.stringify(session), { flag: 'wx', mode: 0o600 });
    await new WorktreeManager(${JSON.stringify(repo)}).linkSession(${JSON.stringify(created.id)}, surfaceId);
    const lane = createLane({ repoPath: repo.localPath, worktreePath: ${JSON.stringify(workspace)},
      branch: session.branch, baseBranch: 'main', runtime: 'codex', packetId, sessionKey: surfaceId, ownership: 'managed' });
    setLaneStatus(lane.id, 'reviewing');
    console.log('O8_GENERATED_RESULT ' + JSON.stringify({ repositoryUuid: repo.id, packetId,
      laneId: lane.id, sessionKey: surfaceId, providerExecutions: 0, terminalAction: 'cleanup' }));
  `)).value;
  const cli = async (...args: string[]) => {
    const result = await invoke([path.join(source, 'scripts/generated-output.mjs'), ...args]);
    return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as { resource: Pick<GeneratedOutputResource, 'resourceId' | 'state' | 'revision' | 'owner' | 'bankCapture'>
      & { producer: GeneratedOutputResource['attempt'] | null } };
  };
  const inspect = async () => (await cold(`
    const database = await import(${url('src/lib/db/index.ts')}); const { getSqlite } = database.default ?? database;
    const tables = {};
    for (const table of ['workspace_generated_outputs', 'workspace_generated_output_recoveries',
      'workspace_generated_output_bank_entries', 'workspace_generated_output_recovery_entries',
      'workspace_exact_claims', 'workspace_exact_finalizations', 'workspace_retention_holds']) {
      tables[table] = getSqlite().prepare('SELECT * FROM ' + table + ' ORDER BY rowid LIMIT 4096').all();
    }
    console.log('O8_GENERATED_RESULT ' + JSON.stringify(tables));
  `)).value as Record<string, Array<Record<string, unknown>>>;
  const cleanup = async (started?: () => void) => {
    let output = ''; let acknowledged = false;
    return cold(`
    const ns = await import(${url('src/lib/worktree/manager.ts')}); const { WorktreeManager } = ns.default ?? ns;
    const pending = new WorktreeManager(${JSON.stringify(repo)}).cleanup(${JSON.stringify(created.id)},
      { force: true, deleteBranch: false, workspaceRetirementAction: 'cleanup' });
    console.log('O8_PARENT_CLEANUP_STARTED');
    const result = await pending;
    console.log('O8_GENERATED_RESULT ' + JSON.stringify(result));
  `, chunk => {
      if (acknowledged) return;
      output += chunk;
      if (output.includes('O8_PARENT_CLEANUP_STARTED')) { acknowledged = true; started?.(); }
      else output = output.slice(-64);
    });
  };
  const preservation = async () => (await cold(`
    const state = await import(${url('src/lib/worktree/snapshot-state.ts')}); const api = state.default ?? state;
    const storage = await import(${url('src/lib/workspace/preservation-store.ts')}); const { readWorkspacePreservation } = storage.default ?? storage;
    const snapshot = api.getWorkspaceSnapshot(${JSON.stringify(ownership.repositoryUuid)}, ${JSON.stringify(ownership.packetId)});
    const transitions = api.listWorkspaceSnapshotTransitions(snapshot.repositoryUuid, snapshot.packetId);
    const admission = transitions.findLast(row => typeof row.receipt?.preservationId === 'string');
    const preserved = await readWorkspacePreservation(admission.receipt.preservationId);
    console.log('O8_GENERATED_RESULT ' + JSON.stringify({ snapshot, admission, preserved }));
  `)).value;
  return { root, repo, data, env, workspace, cli, cold, inspect, cleanup, ownership, preservation };
}

async function contents(root: string) {
  const rows: Array<{ path: string; device: number; inode: number; mode: number; size?: number; sha256?: string }> = [];
  const walk = async (candidate: string) => {
    const stat = await lstat(candidate);
    expect(stat.isSymbolicLink()).toBe(false);
    if (stat.isDirectory()) {
      rows.push({ path: candidate, device: stat.dev, inode: stat.ino, mode: stat.mode & 0o777 });
      for (const name of (await readdir(candidate)).sort()) await walk(path.join(candidate, name));
    } else {
      expect(stat.isFile()).toBe(true);
      rows.push({ path: candidate, device: stat.dev, inode: stat.ino, mode: stat.mode & 0o777,
        size: stat.size, sha256: createHash('sha256').update(await readFile(candidate)).digest('hex') });
    }
  };
  await walk(root); return rows;
}

it('cold parent cleanup preserves active output, failed output and an interrupted native bank journal', async () => {
  const input = await fixture();
  const gate = path.join(input.root, 'allow-owned-producer-exit');
  const next = path.join(input.workspace, 'node_modules/next/dist/bin'); await mkdir(next, { recursive: true });
  // This native compiler stand-in proves the wrapper lifecycle, not Next compilation.
  await writeFile(path.join(next, 'next'), `
    const fs = require('node:fs');
    fs.mkdirSync('.next/cache', { recursive: true });
    fs.writeFileSync('.next/cache/proof.bin', Buffer.alloc(16384, 41), { mode: 0o640 });
    process.stdout.write('O8_PARENT_PRODUCER_READY ' + process.pid + '\\n');
    const poll = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) {
      clearInterval(poll); clearTimeout(bound); process.exit(7); } }, 50);
    const bound = setTimeout(() => process.exit(79), 120000);
  `);
  const producer = exec(process.execPath, [path.join(source, 'scripts/build.mjs')], {
    cwd: input.workspace, env: input.env, timeout: 180_000, maxBuffer: 4 * 1024 ** 2,
  });
  const outcome = producer.then(result => ({ ...result, failed: false }), error => ({
    stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), failed: true,
  }));
  const closed = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
    producer.child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  const ready = new Promise<number>((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => reject(new Error('Native owned producer did not become ready')), 60_000);
    producer.child.stdout!.on('data', chunk => {
      stdout += String(chunk); const match = /^O8_PARENT_PRODUCER_READY (\d+)$/m.exec(stdout);
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
    });
    void closed.then(() => { clearTimeout(timeout); reject(new Error('Owned producer closed before readiness')); });
  });
  const refusals: Array<{ state: string; result: unknown; stderr: string }> = [];
  let id = '';
  let pendingCleanup: Promise<{ response?: { value: unknown; stderr: string }; error?: unknown }> | undefined;
  let concurrent: Awaited<NonNullable<typeof pendingCleanup>> | undefined;
  const preserve = async (state: string, requireOutputGuard: boolean) => {
    const before = await input.inspect();
    const bytes = await contents(path.join(input.workspace, '.next'));
    const parent = await lstat(input.workspace);
    const response = await input.cleanup();
    expect(response.value).toBe(false);
    if (requireOutputGuard) expect(response.stderr).toContain('generated output with unresolved retention');
    expect(await input.inspect()).toEqual(before);
    expect(await contents(path.join(input.workspace, '.next'))).toEqual(bytes);
    const after = await lstat(input.workspace);
    expect({ device: after.dev, inode: after.ino }).toEqual({ device: parent.dev, inode: parent.ino });
    expect(before.workspace_exact_claims).toEqual([]); expect(before.workspace_exact_finalizations).toEqual([]);
    refusals.push({ state, result: response.value, stderr: response.stderr });
  };
  try {
    const nativePid = await ready;
    const tables = await input.inspect();
    const active = JSON.parse(String(tables.workspace_generated_outputs[0].payload_json)) as GeneratedOutputResource;
    id = active.resourceId; expect(active.state).toBe('active');
    expect(active.attempt!.children.some(child => child.pid === nativePid && child.identity && !child.observedClosed)).toBe(true);
    process.kill(nativePid, 0);
    const bytes = await contents(path.join(input.workspace, '.next'));
    const parent = await lstat(input.workspace);
    let acknowledge!: () => void;
    const started = new Promise<void>((resolve, reject) => {
      const bound = setTimeout(() => reject(new Error('Concurrent cleanup did not start')), 60_000);
      acknowledge = () => { clearTimeout(bound); resolve(); };
    });
    pendingCleanup = input.cleanup(acknowledge).then(response => ({ response }), error => ({ error }));
    await started;
    // An active producer owns the packet lease; require its bounded native refusal.
    concurrent = await pendingCleanup;
    if (concurrent.error) throw concurrent.error;
    expect(concurrent.response!.value).toBe(false);
    expect(concurrent.response!.stderr).toContain(`Timed out waiting for the exact workspace lifecycle owner of packet ${input.ownership.packetId}.`);
    expect(await input.inspect()).toEqual(tables);
    expect(await contents(path.join(input.workspace, '.next'))).toEqual(bytes);
    expect((await lstat(input.workspace)).ino).toBe(parent.ino);
    expect(producer.child.exitCode).toBeNull(); process.kill(nativePid, 0);
    refusals.push({ state: 'active-lifecycle-exclusion', result: concurrent.response!.value,
      stderr: concurrent.response!.stderr });
  } finally {
    await writeFile(gate, 'Exit only the new owned native fixture', { mode: 0o600 });
    const result = await outcome; const nativeClose = await closed;
    if (pendingCleanup) concurrent = await pendingCleanup;
    await writeFile(path.join(input.root, 'producer-native-close.json'), JSON.stringify({
      wrapperPid: producer.child.pid, nativeClose, ...result, observedAt: new Date().toISOString(),
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    expect(nativeClose.exitCode).toBe(7);
  }
  const failed = (await input.cli('status', '--resource', id)).resource;
  expect(failed.state).toBe('failed-held');
  expect(failed.producer!.children.every(child => child.observedClosed && child.identity)).toBe(true);
  await preserve('failed-held', true);
  const preserved = await input.preservation();
  expect(preserved.snapshot.state).not.toBe('retired');
  expect(preserved.preserved.payload.handoff.sessionIdentities).toContainEqual(expect.objectContaining({
    kind: 'owned-session', identity: input.ownership.sessionKey }));
  await input.cold(`
    const ns = await import(${url('src/lib/db/index.ts')}); const { getSqlite } = ns.default ?? ns;
    getSqlite().exec("CREATE TRIGGER owned_fixture_bank_failure BEFORE UPDATE ON workspace_generated_output_bank_entries WHEN NEW.phase = 'prepared' BEGIN SELECT RAISE(ABORT, 'owned fixture bank prepared journal failure'); END");
    console.log('O8_GENERATED_RESULT {}');
  `);
  const evidence = [path.join(input.root, 'source-evidence.json'), path.join(input.root, 'stop-evidence.json')];
  await writeFile(evidence[0], JSON.stringify(failed.revision), { mode: 0o600 });
  await writeFile(evidence[1], JSON.stringify(failed.producer), { mode: 0o600 });
  const owner = failed.owner!;
  await expect(input.cli('adopt', '--workspace', input.workspace, '--repository', owner.repositoryPath,
    '--worktree-id', owner.worktreeId, '--intent', 'Preserve new owned failed parent fixture',
    '--evidence', evidence[0], '--evidence', evidence[1])).rejects.toThrow('owned fixture bank prepared journal failure');
  const bankFailed = (await input.cli('status', '--resource', id)).resource;
  expect(bankFailed.bankCapture!.state).toBe('failed-held');
  const journal = (await input.inspect()).workspace_generated_output_bank_entries;
  expect(journal).toHaveLength(1); expect(journal[0].phase).toBe('ready');
  expect(journal[0].observed_closed).toBe(0);
  const native = JSON.parse(String(journal[0].receipt_json));
  expect(native.pid).toBeGreaterThan(0); expect(native.processIdentity).toBeTruthy();
  const bankRoot = bankFailed.bankCapture!.path;
  // Capture actual failed-bank contents and identities; no completed bank is invented.
  const bankBytes = await contents(bankRoot);
  expect(bankBytes.some(row => row.size === 0)).toBe(true);
  await preserve('bank-failed-held', true);
  expect(await contents(bankRoot)).toEqual(bankBytes);
  await writeFile(path.join(input.root, 'native-parent-retention-result.json'), JSON.stringify({
    resourceId: id, ownership: input.ownership, preservation: preserved, refusals, bankBytes,
    final: await input.inspect(), noParentPurgeAdmission: true,
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}, 360_000);
