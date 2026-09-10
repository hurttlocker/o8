import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const ensureDispatchBackendReadyMock = vi.hoisted(() => vi.fn(async () => ({
  ready: true,
  reason: 'test',
  waitedMs: 0,
  attempts: 1,
  lastCheck: {
    ready: true,
    reason: 'test',
    apiBase: 'http://127.0.0.1:1',
    portSource: 'default' as const,
    apiPortFilePresent: false,
  },
})));
const measureHostVolumeMock = vi.hoisted(() => vi.fn(async () => ({
  accountingStatus: 'observed' as const,
  probePath: '/',
  availableBytes: 90_000_000_000,
  freeBytes: 90_000_000_000,
  totalBytes: 100_000_000_000,
  error: null,
})));

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>(),
  ensureDispatchBackendReady: ensureDispatchBackendReadyMock,
}));

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: measureHostVolumeMock,
}));

const testRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-execution-carrier-'));
const dataDir = path.join(testRoot, 'data');
const runtimeDir = path.join(testRoot, 'runtime-bin');
const carrierDir = path.join(testRoot, 'carrier-bin');
const carrierPidFile = path.join(testRoot, 'carrier.pid');
const childPidFile = path.join(testRoot, 'child.pid');
const carrierArgsFile = path.join(testRoot, 'carrier.args');
const shellInjectionSentinel = path.join(testRoot, 'argv-was-interpreted');
const testStorageReserveRatio = 0.000001;
const testStorageReserveFloorGb = 0.001;
const priorEnv = new Map<string, string | undefined>();
const controlledEnv = [
  'CORTEX_IDE_DATA_DIR', 'O8_DATA_DIR', 'CORTEX_IDE_OWNED_CODEX_ROOT',
  'O8_CODEX_BIN', 'O8_ORI_BIN', 'O8_CRASH_SURVIVABLE_WORKERS',
  'O8_SUBSCRIPTION_PROFILE', 'O8_DEFAULT_DISPATCH_RUNTIME',
  'O8_WORKER_SANDBOX', 'O8_WORKTREE_ROOT',
  'O8_APFS_COW_WORKSPACES', 'O8_APFS_DEPENDENCY_IMAGES',
  'O8_PACKAGED_APP', 'O8_DISPATCH_MODEL',
  'O8_STORAGE_RESERVE_RATIO', 'O8_STORAGE_RESERVE_FLOOR_GB',
  'O8_SKIP_PRELAUNCH_TYPECHECK', 'O8_TEST_CARRIER_PID_FILE',
  'O8_TEST_CHILD_PID_FILE', 'O8_TEST_CARRIER_ARGS_FILE',
] as const;

for (const key of controlledEnv) priorEnv.set(key, process.env[key]);

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function writeExecutable(file: string, source: string) {
  writeFileSync(file, source, 'utf8');
  chmodSync(file, 0o755);
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function createRemoteRepo() {
  // Owned-runtime launches are restricted to paths under the home or data
  // directory, so the fixture repo and worktrees live under the fixture data dir.
  const origin = path.join(dataDir, 'origin.git');
  const seed = path.join(dataDir, 'seed');
  const repo = path.join(dataDir, 'repo');
  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, seed], { stdio: 'pipe' });
  git(seed, 'checkout', '-b', 'main');
  writeFileSync(path.join(seed, 'README.md'), 'execution carrier real-path fixture\n');
  git(seed, 'add', 'README.md');
  git(seed, '-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '-m', 'init');
  git(seed, 'push', '-u', 'origin', 'main');
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  return repo;
}

afterAll(async () => {
  for (const pidFile of [carrierPidFile, childPidFile]) {
    if (!existsSync(pidFile)) continue;
    const pid = Number(readFileSync(pidFile, 'utf8'));
    if (Number.isInteger(pid) && isPidAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
  if (process.platform !== 'win32') {
    await import('@/lib/db').then(({ closeDb }) => closeDb()).catch(() => {});
  }
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(testRoot, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('execution carrier isolated worktree real path', () => {
  it('routes launch and resume through Ori while Codex retains identity, evidence, and cleanup', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(carrierDir, { recursive: true });
    const fakeCodex = path.join(runtimeDir, 'codex');
    const fakeOri = path.join(carrierDir, 'ori');
    // Use inspectable processes: the system shell can hide its environment
    // from the macOS process probe, which must hold Stop rather than guess.
    writeExecutable(fakeCodex, `#!${process.execPath}
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (['--version', '-V'].includes(args[0])) { console.log('0.130.0-test'); process.exit(0); }
if (args[0] === 'app-server') process.exit(0);
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'carrier-thread' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'proof', type: 'agent_message', text: 'carrier transcript proof' } }));
writeFileSync('carrier-proof.txt', 'carrier review proof');
if (args.includes('resume')) {
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
}
`);
    writeExecutable(fakeOri, `#!${process.execPath}
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (['--version', '-V'].includes(args[0])) { console.log('0.0.0-test'); process.exit(0); }
if (args[0] === 'auth') process.exit(0);
if (args.shift() !== 'codex') process.exit(64);
writeFileSync(process.env.O8_TEST_CARRIER_ARGS_FILE, ['codex', ...args].join('\\n'));
const child = spawn('codex', args, { stdio: 'inherit' });
child.on('error', () => process.exit(1));
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGTERM'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
writeFileSync(process.env.O8_TEST_CHILD_PID_FILE, String(child.pid));
writeFileSync(process.env.O8_TEST_CARRIER_PID_FILE, String(process.pid));
`);

    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    process.env.O8_DATA_DIR = dataDir;
    process.env.CORTEX_IDE_OWNED_CODEX_ROOT = path.join(testRoot, 'owned-codex');
    process.env.O8_CODEX_BIN = fakeCodex;
    process.env.O8_ORI_BIN = fakeOri;
    process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
    process.env.O8_SUBSCRIPTION_PROFILE = 'both';
    process.env.O8_DEFAULT_DISPATCH_RUNTIME = 'codex';
    process.env.O8_WORKER_SANDBOX = '0';
    process.env.O8_WORKTREE_ROOT = path.join(dataDir, 'worktrees');
    process.env.O8_APFS_COW_WORKSPACES = '0';
    process.env.O8_APFS_DEPENDENCY_IMAGES = '0';
    delete process.env.O8_PACKAGED_APP;
    delete process.env.O8_DISPATCH_MODEL;
    process.env.O8_STORAGE_RESERVE_RATIO = String(testStorageReserveRatio);
    process.env.O8_STORAGE_RESERVE_FLOOR_GB = String(testStorageReserveFloorGb);
    process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
    process.env.O8_TEST_CARRIER_PID_FILE = carrierPidFile;
    process.env.O8_TEST_CHILD_PID_FILE = childPidFile;
    process.env.O8_TEST_CARRIER_ARGS_FILE = carrierArgsFile;

    const repoPath = createRemoteRepo();
    const { addRepo } = await import('@/lib/repos/registry');
    await addRepo(repoPath);
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    const defaults = await updateOperatorDefaults({ defaultDispatchRuntime: 'codex', workerExecutionCarrier: 'ori' });
    expect(defaults.values).toMatchObject({
      storageReserveRatio: testStorageReserveRatio,
      storageReserveFloorGb: testStorageReserveFloorGb,
    });
    expect(defaults.sources).toMatchObject({
      storageReserveRatio: 'env',
      storageReserveFloorGb: 'env',
    });
    const { createMission, dispatchMission } = await import('@/lib/orchestrator/operator-mission-service');
    const mission = await createMission({
      issues: [{ number: 2037, title: 'Prove execution carriers', body: '', url: '' }],
      repoPath,
      runtime: 'codex',
      constraints: '',
    });
    const packetId = mission.packets[0]!.id;
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const packet = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packetId)!;
    expect(packet.executionCarrier).toBe('ori');
    expect((await dispatchMission({ missionId: mission.missionId })).dispatched).toBe(1);

    const dispatchedPacket = readOrchestratorControlPlaneState().packets
      .find((candidate) => candidate.id === packetId)!;
    expect(dispatchedPacket.storageAdmission).toMatchObject({
      ownerId: packetId,
      state: 'committed',
    });

    const { findLaneByPacket, getLaneEvents } = await import('@/lib/lane/registry');
    const lane = findLaneByPacket(packet.id)!;
    expect(lane.worktreePath).toBeTruthy();
    expect(lane.worktreePath).not.toBe(repoPath);
    expect(measureHostVolumeMock).toHaveBeenCalled();
    expect(ensureDispatchBackendReadyMock).toHaveBeenCalledWith('codex', 'launch');
    const runtime = (await import('@/lib/runtimes')).getRuntime('codex')!;
    await waitUntil(async () => {
      const surface = (await runtime.discoverSessions()).find((candidate) => candidate.sessionKey === lane.sessionKey);
      return surface?.lifecycle?.availability === 'ready-for-resume';
    }, 'initial carried Codex run did not reach ready-for-resume');

    const surface = (await runtime.discoverSessions()).find((candidate) => candidate.sessionKey === lane.sessionKey);
    expect(surface).toMatchObject({ runtimeId: 'codex', ownership: 'owned' });
    expect(await runtime.readTranscript(lane.sessionKey!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', text: 'carrier transcript proof' }),
    ]));
    expect(await runtime.getTelemetry?.(lane.sessionKey!)).toMatchObject({ totalTokens: 15, inputTokens: 10, outputTokens: 5 });
    expect(await runtime.getChangedFiles(lane.sessionKey!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'carrier-proof.txt' }),
    ]));
    expect(getLaneEvents(lane.id, 200)).toEqual(expect.arrayContaining([
      expect.objectContaining({ verb: 'execution_carrier_preflight', payload: expect.objectContaining({ runtime: 'codex', executionCarrier: 'ori' }) }),
    ]));

    const maliciousLookingPrompt = `resume; touch ${shellInjectionSentinel}`;
    rmSync(carrierPidFile, { force: true });
    rmSync(childPidFile, { force: true });
    rmSync(carrierArgsFile, { force: true });
    expect((await runtime.resume(lane.sessionKey!, maliciousLookingPrompt)).ok).toBe(true);
    expect(ensureDispatchBackendReadyMock).toHaveBeenCalledWith('codex', 'resume');
    await waitUntil(() => existsSync(carrierPidFile) && existsSync(childPidFile), 'carried resume processes did not start');
    const carrierPid = Number(readFileSync(carrierPidFile, 'utf8'));
    const childPid = Number(readFileSync(childPidFile, 'utf8'));
    expect(isPidAlive(carrierPid)).toBe(true);
    expect(isPidAlive(childPid)).toBe(true);
    expect(readFileSync(carrierArgsFile, 'utf8')).toContain('resume');
    expect(existsSync(shellInjectionSentinel)).toBe(false);

    const worktreePath = lane.worktreePath!;
    const { stopPacket } = await import('@/lib/orchestrator/stop-packet');
    const { lookupOwnedActiveRunFresh } = await import('@/lib/runtimes/shared/owned-session-index');
    const { probeOwnedRunProcessClaim, resolveSpawnedProcessGroupId } = await import('@/lib/runtimes/shared/owned-session/run-process-proof');
    const activeRun = await lookupOwnedActiveRunFresh(lane.sessionKey!);
    expect(activeRun).toMatchObject({ pid: carrierPid, processGroupId: carrierPid, processMarker: expect.any(String) });
    expect(await probeOwnedRunProcessClaim({ pid: carrierPid, marker: activeRun!.processMarker!, rootPid: carrierPid })).toEqual({ state: 'match' });
    expect(await resolveSpawnedProcessGroupId(carrierPid)).toBe(carrierPid);
    const stopped = await stopPacket(packet.id);
    expect(stopped).toMatchObject({ ok: true, killConfirmed: true, interruptedSessions: 1 });
    await waitUntil(() => !isPidAlive(carrierPid) && !isPidAlive(childPid), 'carrier wrapper or runtime child survived stop');
    await waitUntil(() => !existsSync(worktreePath), 'isolated worktree was not reclaimed after stop');
  }, 45_000);
});
