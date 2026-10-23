import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import { buildPiWriteHelper } from './helpers/pi-write-helper';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import { probeOwnedProcessIdentity } from '@/lib/runtimes/shared/owned-session/process-identity';

const root = realpathSync(mkdtempSync(join(getDataDir(), 'codex-server-restart-')));
const data = root;
const repo = join(root, 'repo');
const binary = join(root, 'codex-fixture.mjs');
const token = 'offline-restart-fixture-token';
let helper: string;
let server: ChildProcess | undefined;
let port = 0;
let output = '';
let workerPid = 0;
let workerStart = '';
let surfaceId = '';
let laneId = '';
let launchBody: Record<string, unknown>;

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
const startTime = (pid: number) => execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
function sessionPath() { return join(data, 'owned-codex', surfaceId.slice('codex-owned:'.length), 'session.json'); }
function session(): OwnedSessionRecord { return JSON.parse(readFileSync(sessionPath(), 'utf8')); }
async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`${label}: ${output.slice(-5_000)}`);
}
async function api<T>(path: string, body?: unknown, allowedStatus?: number): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000),
  });
  const value = await response.json();
  if (allowedStatus ? response.status !== allowedStatus : !response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(value)}\n${output.slice(-5_000)}`);
  return value as T;
}
async function startServer(identityHelper = helper) {
  output = '';
  const child = spawn(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx',
    'tests/fixtures/codex-restart-server.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_ENV: 'test', O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
      CORTEX_IDE_OWNED_CODEX_ROOT: join(data, 'owned-codex'), O8_WORKTREE_ROOT: join(root, 'worktrees'),
      O8_CODEX_BIN: binary, O8_PI_WRITE_BIN: identityHelper, O8_WORKER_SANDBOX: 'off', O8_SKIP_PRELAUNCH_TYPECHECK: '1',
      O8_CRASH_SURVIVABLE_WORKERS: '1', O8_RESTART_FIXTURE_ROOT: root, O8_API_PORT: '0' },
  });
  server = child;
  child.stdout?.on('data', chunk => { output += String(chunk); });
  child.stderr?.on('data', chunk => { output += String(chunk); });
  let ready = false;
  child.on('message', message => { port = (message as { port: number }).port; ready = true; });
  await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`Fixture server exited ${child.exitCode}: ${output}`);
    return ready;
  }, 'fresh server startup');
}
async function stopServer(signal: NodeJS.Signals) {
  const child = server;
  server = undefined;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'close');
  child.kill(signal);
  await Promise.race([exited, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not stop: ${output}`)), 10_000);
    timer.unref();
  })]);
}
function state() {
  return api<{ alive: boolean | null; lane: { id: string; sessionKey: string; status: string }; tail: unknown }>(
    `/api/fixture/state?surface=${encodeURIComponent(surfaceId)}&lane=${laneId}`);
}
async function transcript(sinceId?: string) {
  return api<{ transcript: Array<{ id: string; text: string }> }>(
    `/api/runtime/transcript?sessionKey=${encodeURIComponent(surfaceId)}&limit=1000${sinceId ? `&sinceId=${encodeURIComponent(sinceId)}` : ''}`);
}

beforeAll(async () => {
  helper = buildPiWriteHelper();
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'ws-token'), token, { mode: 0o600 });
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'offline restart fixture\n');
  git('add', 'README.md');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture');
  execFileSync('git', ['clone', '--bare', repo, join(root, 'origin.git')], { stdio: 'pipe' });
  git('remote', 'add', 'origin', join(root, 'origin.git'));
  copyFileSync('tests/fixtures/codex-restart-worker.mjs', binary);
  chmodSync(binary, 0o700);
  await startServer();
  const lane = await api<{ id: string }>('/api/fixture/lane', {});
  laneId = lane.id;
  launchBody = { runtime: 'codex', cwd: repo, repoPath: repo, prompt: 'Keep working through server restart.',
    clientMutationId: 'restart-launch-once', packetId: 'pkt-restart-fixture', existingLaneId: laneId,
    branchName: 'inline/restart-fixture', baseBranch: 'main', isolate: true, skipSetup: true,
    model: 'gpt-6.1-sol', effort: 'high', workMode: 'edit' };
  const launched = await api<{ ok: boolean; surfaceId: string }>('/api/runtime/launch', launchBody);
  expect(launched, output).toMatchObject({ ok: true });
  surfaceId = launched.surfaceId;
  await waitFor(async () => {
    await state();
    const saved = session();
    if (saved.recentRuns[0]?.outcome === 'failed') throw new Error(readFileSync(saved.recentRuns[0].stderrPath, 'utf8'));
    return saved.threadId === 'restart-fixture-provider-session';
  }, 'provider session persistence');
  workerPid = session().activeRun!.pid;
  workerStart = startTime(workerPid);
}, 180_000);

afterAll(async () => {
  await stopServer('SIGKILL');
  try { if (workerPid && startTime(workerPid) === workerStart) process.kill(workerPid, 'SIGINT'); } catch { /* Already exited. */ }
  if (existsSync(join(root, 'worker.pid'))) {
    const pid = Number(readFileSync(join(root, 'worker.pid'), 'utf8'));
    // Teardown only our executable, even when launch failed before returning a PID.
    try {
      const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
      if (command.includes(binary)) process.kill(pid, 'SIGINT');
    } catch { /* Already exited. */ }
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'fixture worker teardown');
  }
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('Codex packet survival through the real runtime HTTP routes', () => {
  it('reattaches the original worker, lane and provider session after TERM and KILL with offline output and no duplicate launch', async () => {
    const first = session();
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      const priorTranscript = (await transcript()).transcript;
      const cursor = priorTranscript.at(-1)?.id;
      const priorIds = new Set(priorTranscript.map(entry => entry.id));
      const before = Number(readFileSync(join(root, 'heartbeat'), 'utf8'));
      await stopServer(signal);
      expect(startTime(workerPid)).toBe(workerStart);
      rmSync(join(root, 'offline-written'), { force: true });
      process.kill(workerPid, 'SIGUSR2');
      await waitFor(() => existsSync(join(root, 'offline-written')) && Number(readFileSync(join(root, 'heartbeat'), 'utf8')) > before, 'worker output with no server');
      expect(readFileSync(first.activeRun!.stdoutPath, 'utf8')).toContain('offline-output:');
      await startServer();
      const rebound = await state();
      expect(rebound).toMatchObject({ alive: true, lane: { id: laneId, sessionKey: surfaceId, status: 'running' } });
      expect(session()).toMatchObject({ surfaceId, packetId: first.packetId, threadId: first.threadId,
        activeRun: { id: first.activeRun!.id, pid: workerPid, processIdentity: first.activeRun!.processIdentity } });
      const replay = await api<{ surfaceId: string; replayed?: boolean }>('/api/runtime/launch', launchBody);
      expect(replay.surfaceId).toBe(surfaceId);
      expect(readFileSync(join(root, 'launches.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
      const replayed = (await transcript(cursor)).transcript;
      expect(replayed.some(entry => entry.text.includes('offline-output:'))).toBe(true);
      expect(replayed.every(entry => !priorIds.has(entry.id))).toBe(true);
    }
    // This is the missing contract on the old source: a live PID alone is not identity.
    const saved = session().activeRun as unknown as { processIdentity?: { bootId: string; startId: string } };
    expect(saved.processIdentity).toMatchObject({ bootId: expect.any(String), startId: expect.any(String) });
    const actual = await probeOwnedProcessIdentity(workerPid);
    expect(actual.state).toBe('live');
    if (actual.state === 'live') expect(saved.processIdentity).toEqual(actual.identity);
  }, 90_000);

  it('rejects a matching live PID with a different start time, including stop and legacy records without identity', async () => {
    const original = session();
    const changed = structuredClone(original);
    Object.assign(changed.activeRun!, { processIdentity: { ...original.activeRun!.processIdentity, startId: 'kernel:1:000001' } });
    changed.recentRuns[0] = changed.activeRun!;
    writeFileSync(sessionPath(), JSON.stringify(changed));
    await stopServer('SIGTERM');
    await startServer();
    try {
      expect((await state()).alive).toBe(false);
      const stopped = await api<{ ok: boolean }>('/api/runtime/action', { action: 'interrupt', surfaceId, clientMutationId: 'reject-reused-pid' }, 400);
      expect(stopped.ok).toBe(false);
      expect(startTime(workerPid)).toBe(workerStart);
      await api('/api/fixture/sweep', {});
      expect(session().activeRun?.id).toBe(original.activeRun!.id);
      delete (changed.activeRun as unknown as { processIdentity?: unknown }).processIdentity;
      delete changed.activeRun!.processIdentityRequired;
      changed.recentRuns[0] = changed.activeRun!;
      writeFileSync(sessionPath(), JSON.stringify(changed));
      expect((await state()).alive).not.toBe(true);
      expect(session().activeRun?.id).toBe(original.activeRun!.id);
      const legacyStop = await api<{ ok: boolean }>('/api/runtime/action', { action: 'interrupt', surfaceId, clientMutationId: 'reject-legacy-pid' }, 400);
      expect(legacyStop.ok).toBe(false);
      await api('/api/fixture/sweep', {});
      expect(session().activeRun?.id).toBe(original.activeRun!.id);
    } finally { writeFileSync(sessionPath(), JSON.stringify(original)); }
  }, 45_000);

  it.runIf(process.platform === 'darwin')('holds a survivor when its kernel identity cannot be read', async () => {
    const original = session();
    await stopServer('SIGTERM');
    await startServer(join(root, 'missing-identity-helper'));
    try {
      expect((await state()).alive).not.toBe(true);
      expect(session().activeRun).toEqual(original.activeRun);
      const stopped = await api<{ ok: boolean }>('/api/runtime/action', { action: 'interrupt', surfaceId, clientMutationId: 'reject-unknown-identity' }, 400);
      expect(stopped.ok).toBe(false);
      expect(startTime(workerPid)).toBe(workerStart);
    } finally { await stopServer('SIGTERM'); await startServer(); }
  }, 45_000);

  it('stops the original identified worker through the normal action route after reattachment', async () => {
    await stopServer('SIGTERM');
    await startServer();
    const stopped = await api<{ ok: boolean }>('/api/runtime/action', { action: 'interrupt', surfaceId, clientMutationId: 'stop-original-after-restart' });
    expect(stopped, output).toMatchObject({ ok: true });
    await waitFor(() => { try { process.kill(workerPid, 0); return false; } catch { return true; } }, 'original worker stops');
    await state();
    expect(session().activeRun).toBeUndefined();
    expect(readFileSync(join(root, 'launches.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  }, 45_000);

  it.runIf(process.platform === 'darwin')('replays an uncertain initial launch after restart without launching another worker', async () => {
    await api('/api/runtime/action', { action: 'interrupt', surfaceId, clientMutationId: 'stop-original-after-restart' });
    await stopServer('SIGTERM');
    await startServer(join(root, 'missing-identity-helper'));
    const packetId = 'pkt-uncertain-fixture';
    const branchName = 'inline/uncertain-fixture';
    const lane = await api<{ id: string }>('/api/fixture/lane', { packetId, branch: branchName });
    const body = { ...launchBody, packetId, branchName, existingLaneId: lane.id, clientMutationId: 'uncertain-initial-launch' };
    const uncertain = await api<{ ok: boolean; outcomeUnknown: boolean; surfaceId: string }>('/api/runtime/launch', body, 409);
    expect(uncertain).toMatchObject({ ok: false, outcomeUnknown: true, surfaceId: expect.stringContaining('codex-owned:') });
    surfaceId = uncertain.surfaceId;
    workerPid = session().activeRun!.pid;
    workerStart = startTime(workerPid);
    await waitFor(() => Number(readFileSync(join(root, 'worker.pid'), 'utf8')) === workerPid, 'uncertain worker starts');
    await stopServer('SIGKILL');
    await startServer();
    const replay = await api<{ surfaceId: string; replayed: boolean }>('/api/runtime/launch', body, 409);
    expect(replay).toMatchObject({ surfaceId, replayed: true });
    expect(startTime(workerPid)).toBe(workerStart);
    expect(readFileSync(join(root, 'launches.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  }, 45_000);
});
