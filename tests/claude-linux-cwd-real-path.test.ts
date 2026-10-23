import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeLiveClaudeProcesses } from '@/lib/runtimes/claude-code-process-probe';

let fixtureRoot: string | undefined;
let child: ChildProcess | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  child = undefined;
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

describe.skipIf(process.platform !== 'linux')('Linux live Claude cwd probe', () => {
  it('discovers a real process cwd without lsof or a session-registry file', async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'o8-linux-claude-cwd-'));
    const cwd = join(fixtureRoot, 'repository with spaces');
    const bin = join(fixtureRoot, 'bin');
    await mkdir(cwd);
    await mkdir(bin);
    for (const command of ['bash', 'ps', 'grep']) {
      await symlink(`/usr/bin/${command}`, join(bin, command));
    }
    child = spawn(process.execPath, ['--eval', "process.send('ready'); setInterval(() => {}, 1000);"], {
      argv0: 'claude', cwd, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    await once(child, 'message');
    // The production probe executes real ps/grep, but lsof cannot be found.
    vi.stubEnv('PATH', bin);
    vi.stubEnv('CLAUDE_HOME', join(fixtureRoot, 'empty-cli-state'));
    const result = await probeLiveClaudeProcesses();
    expect(result.processes.find(candidate => candidate.pid === child!.pid)).toEqual({
      pid: child.pid, cwd: await realpath(cwd), sessionId: undefined,
    });
    expect(result.probed).toBe(true);

    // A later persisted registry entry still supplies the exact session ID.
    const sessions = join(fixtureRoot, 'empty-cli-state', 'sessions');
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, `${child.pid}.json`), JSON.stringify({
      cwd: await realpath(cwd), sessionId: 'fixture-session',
    }));
    const restored = await probeLiveClaudeProcesses();
    expect(restored.processes.find(candidate => candidate.pid === child!.pid)).toEqual({
      pid: child.pid, cwd: await realpath(cwd), sessionId: 'fixture-session',
    });

    const partial = await probeLiveClaudeProcesses({
      execFile: async file => {
        if (file === 'bash') return { stdout: `${child!.pid} claude --fixture\n2147483647 claude --fixture\n` };
        throw new Error('lsof unavailable');
      },
      readSessionState: async () => null,
    });
    expect(partial.probed).toBe(false);
    expect(partial.processes.find(candidate => candidate.pid === child!.pid)?.cwd).toBe(await realpath(cwd));
  });

  it('keeps an exited or unreadable candidate inconclusive without inventing a cwd', async () => {
    const result = await probeLiveClaudeProcesses({
      execFile: async file => {
        if (file === 'bash') return { stdout: '2147483647 claude --model fixture\n' };
        throw new Error('lsof unavailable');
      },
      readSessionState: async () => null,
    });
    expect(result).toEqual({ processes: [{ pid: 2147483647 }], probed: false });
  });
});
