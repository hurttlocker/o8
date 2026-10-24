import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createConnection, createServer as createSocketServer, type Server as SocketServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import { O8dSupervisorClient } from '@/lib/runtime/o8d-supervisor';

const credential = 'fixture-supervisor-authentication-value';
const fixtures: Array<{ root: string; server?: ChildProcess; daemon?: ChildProcess; proxy?: SocketServer }> = [];
let binary = '';

async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Supervisor fixture timed out: ${label}`);
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGKILL');
  await closed;
}

beforeAll(async () => {
  binary = process.env.O8D_TEST_BINARY ?? join(process.cwd(), 'crates/o8d/target/debug/o8d');
  if (!process.env.O8D_TEST_BINARY) await promisify(execFile)('cargo', [
    'build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--all-features',
  ]);
}, 180_000);
afterAll(async () => {
  for (const fixture of fixtures) {
    writeFileSync(join(fixture.root, 'finish'), 'finish');
    writeFileSync(join(fixture.root, 'drained'), 'finish');
    await new Promise(resolve => setTimeout(resolve, 200));
    await stop(fixture.server);
    await stop(fixture.daemon);
    if (fixture.proxy) await new Promise<void>(resolve => fixture.proxy!.close(() => resolve()));
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

async function fixture(supervised: boolean, loseSpawnReply = false, raceExit = false, plainLaunch = false) {
  const root = mkdtempSync(join(getDataDir(), 'supervisor-route-'));
  const state = { root, server: undefined as ChildProcess | undefined, daemon: undefined as ChildProcess | undefined, proxy: undefined as SocketServer | undefined };
  fixtures.push(state);
  const repo = join(root, 'repo');
  const worker = join(root, 'worker.mjs');
  const socket = join(root, 'control.sock');
  const daemonSocket = loseSpawnReply || raceExit ? join(root, 'daemon.sock') : socket;
  chmodSync(root, 0o700);
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  git('add', 'README.md');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture');
  execFileSync('git', ['clone', '--bare', repo, join(root, 'origin.git')], { stdio: 'pipe' });
  git('remote', 'add', 'origin', join(root, 'origin.git'));
  copyFileSync('tests/fixtures/o8d-supervisor-worker.mjs', worker);
  chmodSync(worker, 0o700);
  writeFileSync(join(root, 'ws-token'), credential, { mode: 0o600 });
  if (plainLaunch) writeFileSync(join(root, 'parity'), 'deterministic output');
  if (supervised) {
    const daemon = spawn(binary, ['--experimental-supervisor', '--socket', daemonSocket, '--state-dir', root], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, O8D_SUPERVISOR_TOKEN: credential },
    });
    state.daemon = daemon;
    // A baseline binary refuses the new mode; the launch assertion below must
    // still prove the production route selects supervision instead of ignoring it.
    await Promise.race([once(daemon.stdout!, 'data'), once(daemon, 'close')]);
  }
  if (loseSpawnReply || raceExit) {
    let drop = true;
    let race = raceExit;
    state.proxy = createSocketServer({ allowHalfOpen: true }, incoming => {
      let frame = '';
      incoming.on('data', chunk => { frame += String(chunk); });
      incoming.on('end', () => {
        const upstream = createConnection(daemonSocket);
        let reply = '';
        upstream.on('connect', () => upstream.end(frame));
        upstream.on('data', chunk => { reply += String(chunk); });
        upstream.on('end', () => {
          const request = JSON.parse(frame);
          if (request.op === 'spawn' && drop && loseSpawnReply) { drop = false; incoming.destroy(); }
          else if (request.op === 'attach' && race && existsSync(join(root, 'race-armed'))) {
            race = false;
            writeFileSync(join(root, 'finish'), 'finish');
            // Deliver a genuinely live attachment only after the real worker
            // exits. Any later liveness query now sees its terminal receipt.
            void waitFor(() => JSON.parse(readFileSync(join(root, `${request.id}.owner.json`), 'utf8')).state === 'exited', 'race worker exit')
              .then(() => incoming.end(reply)).catch(() => incoming.destroy());
          } else incoming.end(reply);
        });
        upstream.on('error', () => incoming.destroy());
      });
      incoming.on('error', () => {});
    });
    state.proxy.listen(socket);
    await once(state.proxy, 'listening');
    chmodSync(socket, 0o600);
  }
  let port = 0;
  async function start() {
    let output = '';
    const child = spawn(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx',
      'tests/fixtures/codex-restart-server.ts'], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, NODE_ENV: 'test',
        O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root, CORTEX_IDE_OWNED_CODEX_ROOT: join(root, 'owned-codex'),
        O8_WORKTREE_ROOT: join(root, 'worktrees'), O8_CODEX_BIN: worker,
        O8_WORKER_SANDBOX: 'off', O8_SKIP_PRELAUNCH_TYPECHECK: '1', O8_CRASH_SURVIVABLE_WORKERS: '1',
        O8_RESTART_FIXTURE_ROOT: root, O8_API_PORT: '0', O8_PROCESS_SUPERVISOR: supervised ? '1' : undefined,
        O8D_SUPERVISOR_SOCKET: socket },
    });
    state.server = child;
    child.stdout!.on('data', chunk => { output = (output + String(chunk)).slice(-8_000); });
    child.stderr!.on('data', chunk => { output = (output + String(chunk)).slice(-8_000); });
    let ready = false;
    child.on('message', message => { port = (message as { port: number }).port; ready = true; });
    await waitFor(() => {
      if (child.exitCode !== null) throw new Error(`Fixture app server exited: ${output.replaceAll(root, '<fixture>')}`);
      return ready;
    }, 'app server ready');
  }
  async function api(path: string, body?: unknown, allowFailure = false) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json();
    if (!response.ok && !allowFailure) throw new Error(`Fixture route refused: ${response.status} ${JSON.stringify(result).replaceAll(root, '<fixture>')}`);
    return result;
  }
  await start();
  const lane = await api('/api/fixture/lane', {});
  const launched = await api('/api/runtime/launch', { runtime: 'codex', cwd: repo, repoPath: repo,
    prompt: 'Run the offline supervisor fixture.', clientMutationId: 'supervisor-fixture-launch',
    ...(plainLaunch ? { isolate: false } : { packetId: 'pkt-restart-fixture', existingLaneId: lane.id,
      branchName: 'inline/restart-fixture', baseBranch: 'main', isolate: true, skipSetup: true }),
    model: 'gpt-5.4', effort: 'high', workMode: 'edit' }, loseSpawnReply);
  const directories = (await import('node:fs')).readdirSync(join(root, 'owned-codex'));
  const sessionPath = join(root, 'owned-codex', directories[0], 'session.json');
  const session = (): OwnedSessionRecord => JSON.parse(readFileSync(sessionPath, 'utf8'));
  const refresh = () => api(`/api/fixture/state?surface=${encodeURIComponent(session().surfaceId)}&lane=${lane.id}`);
  const transcript = () => api(`/api/runtime/transcript?sessionKey=${encodeURIComponent(session().surfaceId)}&limit=1000`);
  await waitFor(() => {
    const current = session();
    const run = current.activeRun ?? current.recentRuns[0];
    if (!current.activeRun) throw new Error(`Fixture worker exited early: ${JSON.stringify(run.childExit)} ${readFileSync(run.stderrPath, 'utf8')}`);
    return existsSync(run.stdoutPath) && readFileSync(run.stdoutPath, 'utf8').includes('fixture-output');
  }, 'worker output');
  return { root, state, start, session, refresh, transcript, api, launched };
}

describe.skipIf(process.platform !== 'linux')('o8d supervisor through the production runtime launch route', () => {
  it('never settles a later liveness result before consuming the immutable exit receipt', async () => {
    const f = await fixture(true, false, true);
    const first = f.session().activeRun!;
    writeFileSync(join(f.root, 'race-armed'), 'armed');
    await f.api('/api/fixture/fleet');
    expect(f.session().activeRun?.id).toBe(first.id);
    expect(f.session().recentRuns[0].finishedAt).toBeUndefined();
    await f.api('/api/fixture/fleet');
    expect(f.session().recentRuns[0].childExit?.code).toBe(7);
    expect(f.session().activeRun).toBeUndefined();
  }, 180_000);

  it('recovers its prepared journal after a lost spawn reply and server restart without another spawn', async () => {
    const f = await fixture(true, true);
    const first = f.session().activeRun!;
    expect(f.launched.ok).not.toBe(true);
    expect(first).toMatchObject({ pid: 0, spawnState: 'prepared', supervisor: { id: first.id, epoch: '' } });
    const saved = JSON.parse(readFileSync(join(f.root, `${first.id}.owner.json`), 'utf8'));
    await stop(f.state.server);
    await f.start();
    await f.refresh();
    expect(f.session().activeRun).toMatchObject({ id: first.id, pid: saved.pid, spawnState: 'started', supervisor: { epoch: saved.epoch } });
    expect((await import('node:fs')).readdirSync(f.root).filter(name => name.endsWith('.owner.json'))).toHaveLength(1);
    writeFileSync(join(f.root, 'finish'), 'finish');
    await waitFor(async () => { await f.refresh(); return Boolean(f.session().recentRuns[0].childExit); }, 'recovered prepared exit');
  }, 180_000);

  it('refuses a changed ownership record through Stop and signals only after the original record is restored', async () => {
    const f = await fixture(true);
    const run = f.session().activeRun!;
    const ownershipPath = join(f.root, `${run.id}.owner.json`);
    const original = readFileSync(ownershipPath, 'utf8');
    const changed = JSON.parse(original);
    changed.identity.startId = 'simulated-pid-reuse';
    writeFileSync(ownershipPath, JSON.stringify(changed));
    await expect(f.api('/api/runtime/action', { action: 'interrupt', surfaceId: f.session().surfaceId,
      clientMutationId: 'refuse-supervisor-stop' })).rejects.toThrow('Fixture route refused');
    expect(f.session().activeRun?.id).toBe(run.id);
    writeFileSync(ownershipPath, original);
    expect(await f.api('/api/runtime/action', { action: 'interrupt', surfaceId: f.session().surfaceId,
      clientMutationId: 'verified-supervisor-stop' })).toMatchObject({ ok: true });
    await waitFor(async () => { await f.refresh(); return Boolean(f.session().recentRuns[0].childExit); }, 'verified Stop exit');
    expect(f.session().recentRuns[0].childExit?.signal).toBe('SIGINT');
  }, 180_000);

  it.each(['pipes', 'closed'])('retains run, admission and Stop authority with %s descendant output', async output => {
    const f = await fixture(true);
    const run = f.session().activeRun!;
    const client = new O8dSupervisorClient(join(f.root, 'control.sock'), credential);
    writeFileSync(join(f.root, 'drain'), output);
    writeFileSync(join(f.root, 'finish'), 'finish');
    await waitFor(async () => (await client.attach(run.supervisor!)).state === 'draining', 'leader exits while descendant holds output');
    await f.refresh();
    expect(f.session().activeRun?.id).toBe(run.id);
    expect(f.session().recentRuns[0].finishedAt).toBeUndefined();
    await expect(f.api('/api/runtime/action', { action: 'steer', surfaceId: f.session().surfaceId,
      message: 'Must not overlap the draining worker.', clientMutationId: 'refuse-draining-resume' })).rejects.toThrow('Fixture route refused');
    await stop(f.state.server);
    const leases = (await import('node:fs')).readdirSync(join(f.root, 'work-launches')).map(name =>
      JSON.parse(readFileSync(join(f.root, 'work-launches', name), 'utf8')));
    expect(leases.some(lease => lease.ownerPid === f.state.daemon!.pid && lease.pid === f.state.daemon!.pid)).toBe(true);
    await f.start();
    expect(await f.api('/api/runtime/action', { action: 'interrupt', surfaceId: f.session().surfaceId,
      clientMutationId: 'stop-draining-group' })).toMatchObject({ ok: true });
    await waitFor(async () => { await f.refresh(); return Boolean(f.session().recentRuns[0].childExit); }, 'drained terminal receipt');
    expect(f.session().recentRuns[0].childExit?.code).toBe(7);
    expect(f.session().recentRuns[0].outcome).toBe('interrupted');
  }, 180_000);

  it('keeps a worker alive across app SIGKILL and reattaches output and its one exit receipt', async () => {
    const f = await fixture(true);
    const first = f.session().activeRun!;
    expect(first).toHaveProperty('supervisor.id', first.id);
    const before = readFileSync(first.stdoutPath, 'utf8').length;
    await stop(f.state.server);
    await waitFor(() => readFileSync(first.stdoutPath, 'utf8').length > before + 500, 'output while app is absent');
    await f.start();
    expect(await f.refresh()).toMatchObject({ alive: true });
    expect(f.session().activeRun).toMatchObject({ id: first.id, pid: first.pid, processIdentity: first.processIdentity });
    expect(f.session().activeRun!.supervisor!.cursor).toBeGreaterThan(0);
    expect((await f.transcript()).transcript.some((entry: { text: string }) => entry.text.includes('fixture-output'))).toBe(true);
    await stop(f.state.server);
    writeFileSync(join(f.root, 'finish'), 'finish');
    await waitFor(() => JSON.parse(readFileSync(join(f.root, `${first.id}.owner.json`), 'utf8')).state === 'exited', 'exit without app server');
    await f.start();
    await waitFor(async () => { await f.refresh(); return Boolean(f.session().recentRuns[0].childExit); }, 'reattached exit');
    const finished = f.session().recentRuns[0];
    expect(finished.childExit).toMatchObject({ code: 7, signal: null, classification: 'nonzero-exit' });
    expect(f.session().activeRun).toBeUndefined();
    await f.refresh();
    expect(f.session().recentRuns[0].childExit).toEqual(finished.childExit);
    expect(f.state.daemon!.exitCode).toBeNull();
  }, 180_000);

  it('matches child-process stdout, stderr and exit classification with opt-in absent', async () => {
    const outcomes = [];
    for (const enabled of [false, true]) {
      const f = await fixture(enabled, false, false, true);
      const run = f.session().activeRun!;
      expect(Boolean((run as unknown as { supervisor?: unknown }).supervisor)).toBe(enabled);
      writeFileSync(join(f.root, 'finish'), 'finish');
      await waitFor(async () => { await f.refresh(); return Boolean(f.session().recentRuns[0].childExit); }, 'parity exit');
      outcomes.push({ threadId: f.session().threadId, childExit: f.session().recentRuns[0].childExit,
        stderr: readFileSync(run.stderrPath, 'utf8'), stdout: readFileSync(run.stdoutPath, 'utf8') });
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
  }, 180_000);
});
