import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { SANDBOX_EXEC_PATH } from '@/lib/runtimes/shared/owned-session/sandbox';
import { prepareSingleOrchestratorLaunch, singleOrchestratorEnvironment } from './single-orchestrator-policy';

const tempRoots: string[] = [];
const originalDataDir = process.env.CORTEX_IDE_DATA_DIR;
const bundledCodex = '/Applications/ChatGPT.app/Contents/Resources/codex';
const installedCodex = (process.env.PATH ?? '')
  .split(delimiter)
  .map((entry) => join(entry, 'codex'))
  .find(existsSync);

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function runPrepared(
  prepared: Awaited<ReturnType<typeof prepareSingleOrchestratorLaunch>>,
  cwd = process.cwd(),
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(prepared.binary, prepared.args, {
      cwd, env: prepared.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `sandboxed launch exited ${code}`));
    });
  });
}

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = originalDataDir;
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe('Single orchestrator process boundary', () => {
  it('removes inherited control-plane credentials and pins an invalid bearer', () => {
    const env = singleOrchestratorEnvironment({
      ...process.env,
      PATH: '/bin',
      O8_API_TOKEN: 'operator',
      O8_WORKER_TOKEN: 'worker',
      O8_TAURI_MCP_SOCKET: '/tmp/socket',
      WS_TOKEN: 'ws',
      TMUX: '/tmp/tmux/default,1,0',
    }, '/tmp/codex-home');

    expect(env.PATH).toBe('/bin');
    expect(env.CODEX_HOME).toBe('/tmp/codex-home');
    expect(env.O8_API_TOKEN).toBe('single-mode-no-operator-authority');
    expect(env.O8_WORKER_TOKEN).toBeUndefined();
    expect(env.O8_TAURI_MCP_SOCKET).toBeUndefined();
    expect(env.WS_TOKEN).toBeUndefined();
    expect(env.TMUX).toBeUndefined();
  });

  it.skipIf(process.platform !== 'darwin')('keeps repo work available while token and config reads stay denied', async () => {
    const repo = tempRoot('o8-single-repo-');
    const dataDir = tempRoot('o8-single-data-');
    const codexHome = join(dataDir, 'codex-runtime');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(dataDir, 'ws-token'), 'operator-secret');
    writeFileSync(join(codexHome, 'config.toml'), 'embedded-secret');
    writeFileSync(join(codexHome, 'state.txt'), 'resume-state');
    const sourceLauncher = join(dataDir, 'codex-test-launcher');
    writeFileSync(sourceLauncher, '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o700 });
    process.env.CORTEX_IDE_DATA_DIR = dataDir;

    const script = [
      'test "$(cat "$CODEX_SQLITE_HOME/state.txt")" = resume-state',
      'test ! -r "$CODEX_HOME/config.toml"',
      'test ! -r "$CORTEX_IDE_DATA_DIR/ws-token"',
      'env -u O8_API_TOKEN -u O8_WORKER_TOKEN sh -c \'test ! -r "$CORTEX_IDE_DATA_DIR/ws-token"\'',
      'if codex --version; then exit 91; fi',
      'printf ready',
      'sleep 0.2',
      'test ! -x "$O8_TEST_LAUNCH_BINARY"',
      'if chmod 700 "$O8_TEST_LAUNCH_BINARY"; then exit 92; fi',
      'if "$O8_TEST_LAUNCH_BINARY" -c true; then exit 93; fi',
      'printf ok > repo-marker.txt',
    ].join(' && ');
    const prepared = await prepareSingleOrchestratorLaunch({
      repoPath: repo,
      codexHome,
      binary: sourceLauncher,
      args: ['-c', script],
      env: process.env,
    });

    const sibling = await prepareSingleOrchestratorLaunch({
      repoPath: repo, codexHome, binary: sourceLauncher, args: ['-c', 'true'], env: process.env,
    });
    try {
      expect(() => execFileSync(SANDBOX_EXEC_PATH, [
        '-f', prepared.profilePath, '/bin/cat', sibling.launchBinaryPath,
      ], { env: prepared.env })).toThrow();
      expect(() => execFileSync(SANDBOX_EXEC_PATH, [
        '-f', prepared.profilePath, sibling.launchBinaryPath, '-c', 'true',
      ], { env: prepared.env })).toThrow();
      expect(() => execFileSync(SANDBOX_EXEC_PATH, [
        '-f', prepared.profilePath, '/bin/ln', sibling.launchBinaryPath, join(repo, 'sibling-copy'),
      ], { env: prepared.env })).toThrow();
      chmodSync(sibling.launchBinaryPath, 0o000);
      expect(() => execFileSync(SANDBOX_EXEC_PATH, [
        '-f', prepared.profilePath, '/bin/chmod', '700', sibling.launchBinaryPath,
      ], { env: prepared.env })).toThrow();
    } finally {
      sibling.cleanup();
    }
    expect(prepared.profileText).toContain('remote unix-socket');
    expect(prepared.env.CODEX_HOME).toBe(prepared.overlayPath);
    expect(prepared.env.CODEX_SQLITE_HOME).toBe(codexHome);
    expect(readFileSync(prepared.rulesPath, 'utf8')).toContain('decision="forbidden"');
    expect(() => execFileSync(SANDBOX_EXEC_PATH, [
      '-f', prepared.profilePath, '/usr/bin/env', sourceLauncher, '-c', 'true',
    ], { env: prepared.env })).toThrow();
    expect(() => execFileSync(SANDBOX_EXEC_PATH, [
      '-f', prepared.profilePath, '/bin/sh', '-c', `${sourceLauncher} -c true`,
    ], { env: prepared.env })).toThrow();
    expect(() => execFileSync(SANDBOX_EXEC_PATH, [
      '-f', prepared.profilePath, '/usr/bin/xargs', sourceLauncher, '-c', 'true',
    ], { env: prepared.env, input: 'probe\n' })).toThrow();
    expect(() => execFileSync(SANDBOX_EXEC_PATH, [
      '-f', prepared.profilePath, '/bin/sh', '-c', `echo replaced > ${prepared.guardPath}`,
    ], { env: prepared.env })).toThrow();
    const launchRoot = join(prepared.overlayPath, '..');
    prepared.env.O8_TEST_LAUNCH_BINARY = prepared.launchBinaryPath;
    await runPrepared(prepared, repo);
    expect(readFileSync(join(repo, 'repo-marker.txt'), 'utf8')).toBe('ok');
    expect(existsSync(launchRoot)).toBe(false);
    prepared.cleanup();
  });

  it.skipIf(process.platform !== 'darwin' || !installedCodex)('one-shot launches the real Codex binary while wrapper relaunches are OS-denied', async () => {
    const codexHome = tempRoot('o8-single-real-codex-');
    const prepared = await prepareSingleOrchestratorLaunch({
      repoPath: process.cwd(),
      codexHome,
      binary: installedCodex!,
      args: ['--version'],
      env: process.env,
    });
    try {
      const realLauncher = realpathSync(installedCodex!);
      const policy = JSON.parse(execFileSync(installedCodex!, [
        'execpolicy', 'check', '--rules', prepared.rulesPath, 'codex', 'exec',
      ], { env: prepared.env, encoding: 'utf8' })) as { decision?: string };
      expect(policy.decision).toBe('forbidden');
      expect(() => execFileSync(SANDBOX_EXEC_PATH, [
        '-f', prepared.profilePath, '/usr/bin/env', installedCodex!, '--version',
      ], { env: prepared.env })).toThrow();
      expect(() => execFileSync(SANDBOX_EXEC_PATH, [
        '-f', prepared.profilePath, '/bin/sh', '-c', `${realLauncher} --version`,
      ], { env: prepared.env })).toThrow();
      expect(() => execFileSync(SANDBOX_EXEC_PATH, [
        '-f', prepared.profilePath, '/usr/bin/xargs', realLauncher, '--version',
      ], { env: prepared.env, input: 'probe\n' })).toThrow();
      if (existsSync(bundledCodex)) {
        expect(() => execFileSync(SANDBOX_EXEC_PATH, [
          '-f', prepared.profilePath, bundledCodex, '--version',
        ], { env: prepared.env })).toThrow();
        expect(() => execFileSync(SANDBOX_EXEC_PATH, [
          '-f', prepared.profilePath, '/bin/cp', bundledCodex, join(codexHome, 'alternate-worker'),
        ], { env: prepared.env })).toThrow();
      }
      expect(await runPrepared(prepared)).toContain('codex-cli');
      expect(existsSync(join(prepared.overlayPath, '..'))).toBe(false);
    } finally {
      prepared.cleanup();
    }
  }, 30_000);

  it.skipIf(process.platform !== 'darwin')('kills an ignore-TERM grandchild after the supervisor exits', async () => {
    const repo = tempRoot('o8-single-group-repo-');
    const codexHome = tempRoot('o8-single-group-home-');
    const sourceLauncher = join(codexHome, 'codex-test-launcher');
    const pidFile = join(repo, 'grandchild.pid');
    writeFileSync(sourceLauncher, '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o700 });
    const prepared = await prepareSingleOrchestratorLaunch({
      repoPath: repo,
      codexHome,
      binary: sourceLauncher,
      args: ['-c', [
        `/bin/sh -c 'trap "" TERM; echo $$ > ${pidFile}; while :; do sleep 1; done' </dev/null >/dev/null 2>&1 &`,
        "trap 'exit 0' TERM",
        `while [ ! -s ${pidFile} ]; do sleep 0.01; done`,
        'printf ready',
        'while :; do sleep 1; done',
      ].join('\n')],
      env: process.env,
    });
    const supervisor = spawn(prepared.binary, prepared.args, {
      cwd: repo, env: prepared.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        supervisor.stdout.once('data', () => resolve());
        supervisor.once('error', reject);
      });
      const grandchildPid = Number(readFileSync(pidFile, 'utf8').trim());
      const supervisorClosed = new Promise<void>((resolve) => supervisor.once('close', () => resolve()));
      process.kill(-supervisor.pid!, 'SIGTERM');
      await supervisorClosed;
      expect(() => process.kill(grandchildPid, 0)).not.toThrow();
      process.kill(-supervisor.pid!, 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(() => process.kill(grandchildPid, 0)).toThrow();
    } finally {
      try { process.kill(-supervisor.pid!, 'SIGKILL'); } catch {}
      prepared.cleanup();
    }
  }, 10_000);
});
