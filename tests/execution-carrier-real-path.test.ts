import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const testRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-execution-carrier-'));
const dataDir = path.join(testRoot, 'data');
const runtimeDir = path.join(testRoot, 'runtime-bin');
const carrierDir = path.join(testRoot, 'carrier-bin');
const carrierPidFile = path.join(testRoot, 'carrier.pid');
const childPidFile = path.join(testRoot, 'child.pid');
const carrierArgsFile = path.join(testRoot, 'carrier.args');
const shellInjectionSentinel = path.join(testRoot, 'argv-was-interpreted');
const priorEnv = new Map<string, string | undefined>();
const controlledEnv = [
  'CORTEX_IDE_DATA_DIR', 'O8_DATA_DIR', 'CORTEX_IDE_OWNED_CODEX_ROOT',
  'O8_CODEX_BIN', 'O8_ORI_BIN', 'O8_CRASH_SURVIVABLE_WORKERS',
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
  const origin = path.join(testRoot, 'origin.git');
  const seed = path.join(testRoot, 'seed');
  const repo = path.join(testRoot, 'repo');
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
    writeExecutable(fakeCodex, `#!/bin/sh
printf '%s\n' '{"type":"thread.started","thread_id":"carrier-thread"}'
printf '%s\n' '{"type":"item.completed","item":{"id":"proof","type":"agent_message","text":"carrier transcript proof"}}'
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
printf '%s\n' 'carrier review proof' > carrier-proof.txt
case " $* " in
  *" resume "*)
    printf '%s\n' "$$" > "$O8_TEST_CHILD_PID_FILE"
    trap 'exit 0' INT TERM
    while :; do sleep 1; done
    ;;
esac
`);
    writeExecutable(fakeOri, `#!/bin/sh
if [ "$1" = "auth" ]; then exit 0; fi
printf '%s\n' "$$" > "$O8_TEST_CARRIER_PID_FILE"
printf '%s\n' "$@" > "$O8_TEST_CARRIER_ARGS_FILE"
if [ "$1" != "codex" ]; then exit 64; fi
shift
codex "$@" &
child=$!
printf '%s\n' "$child" > "$O8_TEST_CHILD_PID_FILE"
trap 'kill -TERM "$child" 2>/dev/null; wait "$child"; exit 0' INT TERM
wait "$child"
`);

    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    process.env.O8_DATA_DIR = dataDir;
    process.env.CORTEX_IDE_OWNED_CODEX_ROOT = path.join(testRoot, 'owned-codex');
    process.env.O8_CODEX_BIN = fakeCodex;
    process.env.O8_ORI_BIN = fakeOri;
    process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
    process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
    process.env.O8_TEST_CARRIER_PID_FILE = carrierPidFile;
    process.env.O8_TEST_CHILD_PID_FILE = childPidFile;
    process.env.O8_TEST_CARRIER_ARGS_FILE = carrierArgsFile;

    const repoPath = createRemoteRepo();
    const { addRepo } = await import('@/lib/repos/registry');
    await addRepo(repoPath);
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    await updateOperatorDefaults({ defaultDispatchRuntime: 'codex', workerExecutionCarrier: 'ori' });
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

    const { findLaneByPacket, getLaneEvents } = await import('@/lib/lane/registry');
    const lane = findLaneByPacket(packet.id)!;
    expect(lane.worktreePath).toBeTruthy();
    expect(lane.worktreePath).not.toBe(repoPath);
    const runtime = (await import('@/lib/runtimes')).getRuntime('codex')!;
    await waitUntil(async () => {
      const surface = (await runtime.discoverSessions()).find((candidate) => candidate.sessionKey === lane.sessionKey);
      return surface?.lifecycle?.availability === 'ready-for-resume';
    }, 'initial carried Codex run did not reach ready-for-resume');

    const surface = (await runtime.discoverSessions()).find((candidate) => candidate.sessionKey === lane.sessionKey);
    expect(surface).toMatchObject({ runtimeId: 'codex', ownership: 'o8-owned' });
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
    await waitUntil(() => existsSync(carrierPidFile) && existsSync(childPidFile), 'carried resume processes did not start');
    const carrierPid = Number(readFileSync(carrierPidFile, 'utf8'));
    const childPid = Number(readFileSync(childPidFile, 'utf8'));
    expect(isPidAlive(carrierPid)).toBe(true);
    expect(isPidAlive(childPid)).toBe(true);
    expect(readFileSync(carrierArgsFile, 'utf8')).toContain('resume');
    expect(existsSync(shellInjectionSentinel)).toBe(false);

    const worktreePath = lane.worktreePath!;
    const { stopPacket } = await import('@/lib/orchestrator/stop-packet');
    const stopped = await stopPacket(packet.id);
    expect(stopped).toMatchObject({ ok: true, killConfirmed: true, interruptedSessions: 1 });
    await waitUntil(() => !isPidAlive(carrierPid) && !isPidAlive(childPid), 'carrier wrapper or runtime child survived stop');
    await waitUntil(() => !existsSync(worktreePath), 'isolated worktree was not reclaimed after stop');
  }, 45_000);
});
